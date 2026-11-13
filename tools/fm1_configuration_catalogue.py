#!/usr/bin/env python3
"""Build the owner-facing catalogue from retained evidence. Never contacts hardware."""
import argparse
import collections
import datetime
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
CURRENT = 'cf98f1087249abe6d9e55363eab789459d0f970ce2d9a1e6f4b0109dc6745c5d'
FX = ['drive', 'chorus', 'delay', 'reverb']
RECOMMENDATIONS = ('Include', 'Needs more testing', 'Exclude')
EXAMPLES = {'Init', 'Simple FM', 'Plucked String', 'Basic Poly', 'Drift Poly', 'Mono Lead', 'Supersaw Stack', '<7PH'}


def load(path):
    return json.loads(path.read_text())


def peak(values):
    actual = [v for v in values if v is not None]
    return max(actual) if actual else None


def source_name(path):
    text = str(path)
    for prefix in (str(ROOT.parent) + '/', str(ROOT) + '/'):
        if text.startswith(prefix):
            return text[len(prefix):]
    return text


def observation(file, case, firmware=None, expected=None, early=False):
    phases = case.get('phases', [])
    ps = []
    for p in phases:
        ps.append({'id': p.get('id', p.get('label')), 'peakPercent': p.get('cpuPercent'),
                   'mute': p.get('overload'), 'shed': p.get('shed'),
                   'late': p.get('observedLate', p.get('late')), 'passed': p.get('passed'),
                   'binarySha256': p.get('sha256')})
        for key in ('seconds', 'targetSeconds', 'completedSampling', 'strict95Passed'):
            if key in p:
                ps[-1][key] = p[key]
    required = expected if expected is not None else case.get('plannedPhases')
    complete = required is not None and len(ps) == required
    clean = bool(ps) and all(all(p[k] == 0 for k in ('mute', 'shed', 'late')) for p in ps)
    return {'source': source_name(file), 'record': case.get('variantId', case.get('sha256', case.get('name'))),
            'firmwareSha256': firmware, 'current': firmware == CURRENT,
            'method': 'Earlier recipe / live setup' if early else 'Precompiled stress; first-render peak retained',
            'observedPhases': len(ps), 'requiredPhases': required,
            'complete': complete, 'cleanObserved': clean,
            'peakPercent': peak(p['peakPercent'] for p in ps),
            'mute': peak(p['mute'] for p in ps), 'shed': peak(p['shed'] for p in ps),
            'late': peak(p['late'] for p in ps),
            'passed': bool(case.get('passed', case.get('allObservedPassed'))) and complete and clean,
            'phases': ps}


def articulation(row):
    mode, name = row.get('paraphony'), row['instrument']
    if mode == 'shared-filter':
        return 'Shared filter / filter envelope / keytracking; independent per-note amplitude and release'
    if mode == 'shared-articulation':
        return 'Shared filter AND amplitude phrase; overlapping notes lose independent attack/release'
    if mode == 'shared-contours':
        return ('Shared DCO/DCW curves; independent per-note DCA amplitude/release' if name == 'Cassia 1'
                else 'Shared operator 3+4 envelopes; oscillator banks/algorithms remain per note')
    if mode == 'shared-operator4':
        return 'Shared operator 4 envelope only; oscillator banks/algorithms remain per note'
    if name in ('Wanderer', 'Vernon 100'):
        return 'Original two-pitch paraphony'
    if name == 'Hera 4':
        return 'Original polyphony: independent per-note filter and amplitude envelopes'
    return 'Original articulation retained'


def signature(row):
    return (row['instrument'], tuple(x.get('voices') for x in row.get('allocations', [])),
            row.get('paraphony'), tuple(sorted(row.get('addedFx', []))),
            json.dumps(row.get('qualityChanges', []), sort_keys=True), row.get('harmonizerRemoved', False))


def apply_polyphony_policy(row, reference):
    row['originalSynth'] = ({key: reference[key] for key in ('model', 'baselineNotes', 'articulation')}
                            if reference else None)
    row['fullFxRack'] = None if row['totalFx'] is None else set(FX).issubset(row['totalFx'])
    at_parity = bool(reference and row['playedNotes'] is not None and
                     row['playedNotes'] >= reference['baselineNotes'])
    row['fxPreference'] = len(row['totalFx'] or []) if at_parity else 0
    row['extraVoicesAtFxExpense'] = bool(not row['protected'] and at_parity and
                                        row['playedNotes'] > reference['baselineNotes'] and
                                        row['fullFxRack'] is False)
    return row['extraVoicesAtFxExpense']


def _scoped_retest(row, source, policy):
    """Resolve only the explicitly scoped final retest, preserving all earlier observations."""
    if not policy or policy.get('id') != 'owner-five-complete-clean-under100' or row['id'] not in policy.get('scope', []):
        return None
    matches = [o for o in row['observations'] if o['current'] and o['source'] == source]
    if not matches:
        return None
    if len(matches) != 1:
        raise ValueError('Ambiguous final owner retest: ' + row['id'])
    o = matches[0]
    phases, percent = o['phases'], o['peakPercent']
    accepted = bool(o.get('recordedPolicyPassed') and o.get('recordedPolicyId') == policy['id'] and o['complete'] and o['cleanObserved'] and
                    isinstance(percent, (int, float)) and 0 <= percent < 100 and
                    phases and len({p['id'] for p in phases}) == o['requiredPhases'] and
                    all(p['passed'] and p.get('completedSampling') is True and p.get('seconds', 0) >= 5 for p in phases))
    return {'observation': o, 'accepted': accepted,
            'strict95Passed': accepted and percent <= 95, 'policyId': policy['id']}


def shortlist(rows):
    """Remove only older measured configurations covered by a final current pass."""
    rows = list(rows)
    replacements = [r for r in rows if r['recommendation'] == 'Include' and
                    not r.get('reducedHeadroomAcceptance') and
                    any(o['current'] and o['passed'] for o in r['observations'])]
    kept, superseded = [], {}
    for row in rows:
        # Unknown identity, unmeasured preparations and current results are not obsolete by inference.
        older = [o for o in row['observations'] if o['observedPhases'] > 0]
        if (row['selected'] or row['evidenceScope'] == 'Current' or not older or
                row['playedNotes'] is None or row['totalFx'] is None or row.get('qualityFlags')):
            kept.append(row)
            continue
        for other in replacements:
            less_coupled = (other['paraphony'] == row['paraphony'] or other['paraphony'] is None or
                            (other['paraphony'] == 'shared-filter' and row['paraphony'] == 'shared-articulation'))
            changes = {json.dumps(x, sort_keys=True) for x in row['qualityChanges']}
            other_changes = {json.dumps(x, sort_keys=True) for x in other['qualityChanges']}
            allocations = row['allocations']
            other_allocations = other['allocations']
            if (other['instrument'] != row['instrument'] or not less_coupled or
                    other['playedNotes'] < row['playedNotes'] or
                    other['nativeFx'] != row['nativeFx'] or
                    other.get('harmonizerRemoved', False) != row.get('harmonizerRemoved', False) or
                    not set(other['addedFx']).issuperset(row['addedFx']) or
                    not other_changes.issubset(changes) or
                    [a['module'] for a in other_allocations] != [a['module'] for a in allocations] or
                    any(a['voices'] < b['voices'] for a, b in zip(other_allocations, allocations))):
                continue
            superseded[row['id']] = {
                'replacementId': other['id'],
                'basis': 'Later final current-firmware complete pass; at least the same played notes and added FX, '
                         'same intrinsic FX, no additional articulation coupling or DSP compromises.',
                'chronologyBasis': 'Replaced entry has only earlier retained measurements; replacement is the final current-package qualification.',
                'earlierEvidence': older,
                'replacementEvidence': [o for o in other['observations'] if o['current'] and o['passed']]}
            break
        else:
            kept.append(row)
    return kept, superseded


def generate(args):
    evidence = args.evidence.resolve()
    manifest = load(ROOT / 'build/selected-fm1-bank-untuned/manifest.json')
    native = {x['name']: x['intrinsicFx'] for x in manifest['entries']}
    art = load(args.articulation)
    parity_path = ROOT / 'docs/measurements/2026-11-12-original-synth-polyphony.json'
    parity = load(parity_path)
    priorities_path = ROOT / 'docs/measurements/2026-11-12-fm1-retest-priorities.json'
    mono_path = ROOT / 'docs/measurements/2026-11-12-mono-no-harm-retest.json'
    priorities, mono_retest = load(priorities_path), load(mono_path)
    owner_path = ROOT / 'docs/measurements/2026-11-12-owner-five-retest.json'
    owner_retest = load(owner_path) if owner_path.exists() else None
    owner_source = source_name(evidence / owner_retest['evidenceFile']) if owner_retest else None
    art_rows = {r['variantId']: r for group in ('historicalAndPreparationRows', 'currentSelectedRows') for r in art[group]}
    rows, sources, coverage = {}, {}, []

    def note_source(path):
        if path.exists():
            sources[source_name(path)] = hashlib.sha256(path.read_bytes()).hexdigest()

    note_source(parity_path)
    note_source(priorities_path)
    note_source(mono_path)
    note_source(owner_path)

    def ensure(case):
        id = case['variantId']
        if id not in rows:
            name = case['originalName']
            rows[id] = {'id': id, 'instrument': name, 'generation': 'Bank-fitting profile',
                        'allocations': case.get('actualAllocCounts', []),
                        'originalAllocations': case.get('originalAllocCounts', []),
                        'controlAllocators': case.get('addedControlAllocators', []),
                        'paraphony': case.get('paraphony'), 'addedFx': case.get('presentFx', []),
                        'nativeFx': native.get(name, []), 'qualityChanges': case.get('qualityChanges', []),
                        'observations': [], 'preparedVersions': [], 'currentBlock': None,
                        'selected': id.startswith('selected-'), 'protected': False, 'notes': []}
            rows[id]['harmonizerRemoved'] = bool(case.get('harmonizerRemoved'))
            rows[id]['basedOnVariantId'] = case.get('basedOnVariantId')
        row = rows[id]
        if case.get('textOnlyChanges'):
            row['textOnlyChanges'] = case['textOnlyChanges']
            row['rebuildFromSelectedCanvas'] = bool(case.get('rebuildFromSelectedCanvas'))
        extra = art_rows.get(id)
        if extra:
            row['qualityChanges'] = extra.get('qualityChanges') or row['qualityChanges']
            row['profile'] = extra.get('profileDescription') or articulation(row)
            if extra.get('sourceNotes') and extra['sourceNotes'] not in row['notes']:
                row['notes'].append(extra['sourceNotes'])
        else:
            row['profile'] = articulation(row)
        return row

    preparation = sorted((ROOT / 'build/fx-clone-variants').glob('*/cases.json'))
    preparation += [ROOT / 'build/selected-bank-qualification/cases.json']
    for path in preparation:
        note_source(path)
        doc = load(path)
        for case in doc.get('cases', []):
            row = ensure(case)
            blocked = [s for s in doc.get('skipped', []) if s.get('variantId') == row['id']]
            ids = [p['id'] for p in case.get('phases', [])] + [p['phaseId'] for p in blocked]
            default = pathlib.Path(case['defaultJson'])
            version = {'source': source_name(path), 'batch': path.parent.name,
                       'sourcePatchSha256': hashlib.sha256(default.read_bytes()).hexdigest() if default.exists() else None,
                       'requiredPhases': len(set(ids)), 'blockedPhases': len(blocked),
                       'blocks': [x for b in blocked for x in b.get('hardCapFailures', [])],
                       'maxBudgetBytes': peak(p.get('budgetBytes') for p in case.get('phases', [])),
                       'maxModelCpuPercent': peak(p.get('modelCpuPercent') for p in case.get('phases', []))}
            row['preparedVersions'].append(version)
            if doc.get('firmwarePackageSha256') == CURRENT and version['blocks']:
                row['currentBlock'] = {'status': 'resource-blocked', 'source': source_name(path),
                                       'hardCapFailures': version['blocks'], 'budgetBytes': version['maxBudgetBytes']}
        coverage.append({'source': source_name(path), 'kind': 'preparation', 'records': len(doc.get('cases', []))})

    for path in sorted(evidence.glob('*hardware.json')):
        doc = load(path)
        cases = doc.get('cases', []) if isinstance(doc, dict) else []
        cases = [c for c in cases if 'variantId' in c]
        if not cases:
            continue
        note_source(path)
        for case in cases:
            row = ensure(case)
            planned = len(case['expectedPhases']) if 'expectedPhases' in case else (8 if 'drive' in row['addedFx'] else 4)
            observed = observation(path, case, doc.get('firmwarePackageSha256'), planned)
            if doc.get('acceptancePolicy'):
                observed['recordedPolicyId'] = doc['acceptancePolicy']['id']
                observed['recordedPolicyPassed'] = observed['passed']
                # Generic qualification remains the standard 95% contract; scoped acceptance is resolved separately.
                observed['passed'] = observed['passed'] and observed['peakPercent'] <= 95
            row['observations'].append(observed)
        coverage.append({'source': source_name(path), 'kind': 'measurement', 'records': len(cases)})

    # Current blocked alternatives have no hardware case; their summary preserves the native resource gate.
    path = evidence / 'historical-retest-summary.json'
    note_source(path)
    for item in load(path)['rows']:
        if item['status'] == 'resource-blocked':
            rows[item['variantId']]['currentBlock'] = item

    early_records = load(args.early)
    note_source(args.early)
    note_source(args.articulation)
    for item in early_records:
        role = item['recordRole']
        target = item.get('mergeInto')
        if role in ('summary-enrichment-not-extra-configuration', 'blocked-metadata-enrichment'):
            if target not in rows:
                raise ValueError('Missing enriched configuration ' + str(target))
            continue  # already represented by owning prepared and measured records above
        if role == 'legacy-version-enrichment':
            row = rows[target]
        else:
            row = {'id': item['identity'], 'instrument': item['instrument'], 'generation': item['generation'],
                   'allocations': item.get('actualAllocCounts') or [],
                   'originalAllocations': item.get('originalAllocCounts') or [],
                   'controlAllocators': item.get('addedControlAllocators') or [], 'paraphony': None,
                   'profile': item['articulation']['description'] or 'Original graph/articulation unresolved for this retained binary',
                   'addedFx': item['fx'].get('addedKinds') or [],
                   'nativeFx': item['fx'].get('nativeKinds') or [], 'qualityChanges': [], 'observations': [],
                   'preparedVersions': [], 'currentBlock': None, 'selected': False, 'protected': False,
                   'notes': item.get('unknownFields', []), 'researchRole': role,
                   'fxKnown': item['fx'].get('totalKinds') is not None,
                   'playedNotesKnown': item.get('voiceCount') is not None,
                   'qualityFlags': item.get('qualityFlags', [])}
            rows[row['id']] = row
            if role == 'distinct-draft-configuration':
                row['notes'].append('Earlier paired L/R Reverb topology; not the final mono-wet rack.')
            if item.get('preparation'):
                row['preparation'] = item['preparation']
        for measured in item.get('measurements', []):
            case = dict(measured, passed=measured.get('allObservedPassed'), plannedPhases=measured.get('plannedPhases'))
            row['observations'].append(observation(pathlib.Path(measured['source']['file']), case,
                                                   expected=measured.get('plannedPhases'), early=True))
            note_source(pathlib.Path(measured['source']['file']))
        for source in item.get('sources', []):
            note_source(pathlib.Path(source['file']))

    for item in manifest['entries']:
        if not item['protected']:
            continue
        rows['protected-' + item['name'].lower().replace(' ', '-')] = {
            'id': 'protected-' + item['name'].lower().replace(' ', '-'), 'instrument': item['name'],
            'generation': 'Protected source patch', 'allocations': item['allocations'], 'originalAllocations': item['allocations'],
            'controlAllocators': [], 'paraphony': None, 'profile': 'Protected source patch unchanged; no FX/player rewriting',
            'addedFx': [], 'nativeFx': [], 'qualityChanges': [], 'observations': [], 'preparedVersions': [],
            'currentBlock': None, 'selected': True, 'protected': True,
            'notes': ['Intrinsic instrument processing retained; no complete four-kind FX audit or new hardware survey claimed.']}

    selected_signatures = {signature(r): r['id'] for r in rows.values() if r['selected'] and not r['protected']}
    for row in rows.values():
        row['fxKnown'] = row.get('fxKnown', not row['protected'])
        row['totalFx'] = [kind for kind in FX if kind in set(row['addedFx'] + row['nativeFx'])] if row['fxKnown'] else None
        alloc = row['allocations']
        row['playedNotes'] = 2 if row['instrument'] in ('Wanderer', 'Vernon 100') and alloc else (alloc[0]['voices'] if alloc else None)
        if row.get('playedNotesKnown') is False:
            row['playedNotes'] = None
        row['auxiliaryVoices'] = [x['voices'] for x in alloc[1:]] if row['instrument'] not in ('Wanderer', 'Vernon 100') and row.get('playedNotesKnown') is not False else []
        excess_polyphony = apply_polyphony_policy(row, parity.get(row['instrument']))
        measured = [o for o in row['observations'] if o['observedPhases'] > 0]
        current = [o for o in measured if o['current']]
        if current:
            # A measured upload supersedes an earlier encoding's host byte block; history retains the old preparation.
            row['currentBlock'] = None
        # The explicitly requested final retest is authoritative for its five cases; all old peaks remain in history.
        scoped = _scoped_retest(row, owner_source, owner_retest['acceptancePolicy'] if owner_retest else None)
        display = scoped['observation'] if scoped else max(current or measured, key=lambda o: o['peakPercent'] if o['peakPercent'] is not None else -1, default=None)
        row['ownerRetest'] = ({key: value for key, value in scoped.items() if key != 'observation'} if scoped else None)
        row['reducedHeadroomAcceptance'] = bool(scoped and scoped['accepted'] and not scoped['strict95Passed'])
        if scoped and row['id'] == 'hera-4-v3-none':
            row['proposedBankName'] = 'Hera 3'
        row['displayEvidence'] = display
        row['evidenceScope'] = 'Current' if current or row['currentBlock'] else 'Protected / not re-surveyed' if row['protected'] else 'Older only' if display else 'Prepared only'
        row['thresholdOnly'] = bool(current and display['cleanObserved'] and display['peakPercent'] > 95 and not (scoped and scoped['accepted']))
        row['priority'] = 50
        if row['protected']:
            decision, reason = 'Include', 'Keep the approved source unchanged; not a fresh hardware qualification.'
        elif excess_polyphony:
            original = row['originalSynth']
            decision, reason = 'Exclude', (
                f"FX-first policy: {row['playedNotes']} notes exceed {original['model']}'s "
                f"{original['baselineNotes']}-note parity while the full rack is incomplete. "
                'Spend headroom on missing effects before voices beyond the original instrument.')
        elif scoped and scoped['accepted']:
            decision, reason = 'Include', (
                'Complete current-firmware retest, five seconds per phase with zero observed guards. ' +
                ('Meets the standard 95% headroom ceiling. ' if scoped['strict95Passed'] else
                 'Accepted under the scoped owner retest interpretation: below 100%, but exceeds the 95% headroom target. ') +
                'Additional audition candidate; published bank unchanged.')
            row['priority'] = 1
        elif scoped and display['peakPercent'] is not None and display['peakPercent'] >= 100:
            decision, reason = 'Exclude', 'Requested retest exhausted the realtime CPU budget; not eligible under the scoped below-100% acceptance.'
        elif current and not scoped and all(o['passed'] for o in current):
            decision, reason = 'Include', 'Complete current-firmware pass; ' + ('published selection, pending owner listening.' if row['selected'] else 'additional audition candidate, not yet selected for the bank.')
            row['priority'] = 0 if row['selected'] else 1
        elif row['currentBlock']:
            decision, reason = 'Exclude', 'Current native patch exceeds the byte budget before upload; removing the CPU ceiling cannot fix this.'
        elif current and not display['cleanObserved']:
            decision, reason = 'Exclude', 'Current measured mute, shedding or late halves: not merely a 95% ceiling rejection.'
        elif row['thresholdOnly']:
            decision, reason = 'Needs more testing', 'Observed phases are clean but above 95%. Needs genuine headroom improvement or an explicit owner ceiling decision, then full-matrix qualification; untested phases remain unknown.'
            row['priority'] = 2
        elif row['qualityChanges']:
            decision, reason = 'Exclude', 'Unnecessary Canvas DSP compromise: the original-DSP published profile already qualifies.'
        elif row['instrument'] in EXAMPLES:
            decision, reason = 'Exclude', 'Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy.'
        elif row.get('researchRole') in ('distinct-draft-configuration', 'legacy-version-distinctness-unresolved'):
            decision, reason = 'Exclude', 'Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed.'
        elif signature(row) in selected_signatures:
            decision, reason = 'Exclude', 'Superseded experiment for the selected profile; use its current-qualified published encoding: ' + selected_signatures[signature(row)] + '.'
        elif row['playedNotes'] is not None and row['playedNotes'] < 3 and row['instrument'] in ('Oracle V', 'Hera 4', 'Algo Four', 'Io 4', 'Cassia 1'):
            decision, reason = 'Exclude', 'Below the agreed three-note floor for these originally polyphonic instruments.'
        else:
            decision, reason = 'Needs more testing', 'No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible.'
            if any(o['passed'] for o in row['observations']):
                row['priority'] = 3
                reason = 'Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition.'
            if row.get('paraphony') in ('shared-articulation', 'shared-contours', 'shared-operator4'):
                reason += ' Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent.'
            if not display:
                reason = 'Prepared or historically byte-blocked only; confirm the current native byte budget before any CPU qualification.'
        row['recommendation'], row['reason'] = decision, reason

    for row in rows.values():
        if row.get('harmonizerRemoved'):
            base = rows.get(row.get('basedOnVariantId'))
            if base:
                base['harmonizerFreeRetest'] = row['id']
                base['reason'] += ' Harmonizer-free retest: ' + row['id'] + ' (' + row['recommendation'] + '); its result does not qualify this harmonizer-enabled configuration.'
            if row['recommendation'] == 'Needs more testing' and not row['displayEvidence']:
                row['reason'] = 'Harmonizer physically removed; mono voice, intrinsic DSP, Steps and Arp retained. Host resources fit; live qualification remains pending. No new hardware CPU result.'
    for item in priorities['candidates']:
        row = rows[item['variantId']]
        if row['recommendation'] == 'Needs more testing':
            row['retestPriority'] = {'rank': item['rank'], 'why': item['why']}
    original_count = len(rows)
    original_names = {r['instrument'] for r in rows.values()}
    retained, superseded = shortlist(rows.values())
    rows = {r['id']: r for r in retained}
    referenced = {source_name(args.early), source_name(args.articulation)}
    referenced.add(source_name(parity_path))
    referenced.update((source_name(priorities_path), source_name(mono_path)))
    if owner_retest:
        referenced.add(source_name(owner_path))
    for row in rows.values():
        referenced.update(o['source'] for o in row['observations'])
        referenced.update(p['source'] for p in row['preparedVersions'])
    for proof in superseded.values():
        referenced.update(o['source'] for o in proof['earlierEvidence'])
        referenced.update(o['source'] for o in proof['replacementEvidence'])
    sources = {name: digest for name, digest in sources.items() if name in referenced}
    coverage = [entry for entry in coverage if entry['source'] in referenced]
    rank = {name: index for index, name in enumerate(RECOMMENDATIONS)}
    groups = collections.defaultdict(list)
    for row in rows.values():
        groups[row['instrument']].append(row)
    for group in groups.values():
        group.sort(key=lambda r: (rank[r['recommendation']], -r['fxPreference'],
                                 r.get('retestPriority', {}).get('rank', 999), r['priority'], r['id']))
    group_names = sorted(groups, key=lambda name: (rank[groups[name][0]['recommendation']], name.casefold()))
    bank_names = {entry['name'] for entry in manifest['entries']}
    included_names = {r['instrument'] for r in rows.values() if r['recommendation'] == 'Include'}
    nominations = {
        'bankInstruments': sorted(bank_names),
        'withoutInclusion': sorted(bank_names - included_names),
        'currentQualified': sorted({r['instrument'] for r in rows.values()
                                    if r['recommendation'] == 'Include' and r['evidenceScope'] == 'Current'}),
        'protectedNotResurveyed': sorted({r['instrument'] for r in rows.values() if r['protected']}),
        'outsideBankPolicy': sorted(original_names - bank_names)}

    result = {'title': 'FM-1 configuration catalogue', 'created': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'currentFirmwareSha256': CURRENT, 'cpuCeilingPercent': 95,
              'originalSynthReferences': parity,
              'polyphonyPolicy': 'At original-synth polyphony parity, prioritize the fullest FX rack. Exclude above-parity configurations without all four FX kinds; extra voices are eligible only after the full rack is present.',
              'scope': 'All retained configurations and recommendation classes except older measured entries demonstrably superseded by final current-firmware passes on the same or a dominating configuration. Unknown, unmeasured, failed and excluded configurations remain unless that replacement is established.',
              'recommendationMeaning': {'Include': 'Eligible audition candidate/current selection or protected source; not a demand to put duplicate instruments in the bank and not owner sound approval.',
                  'Needs more testing': 'Potential configuration without complete current qualification; older passes, failures, partial runs and unmeasured preparations are distinguished.',
                  'Exclude': 'Recommendation against inclusion for the stated resource, guard, policy or unresolved-identity reason; exclusion is not a deletion criterion.'},
              'exclusions': ['Isolated kernel/effect attribution and parameter-rate probes are engineering tests, not independent prepared bank configurations.',
                  'Original legacy/XL source snapshots are provenance, not additional FX-fitting experiments.',
                  'C9/Arp/Drive-mode changes are phase stimuli, not duplicated configuration rows.'],
              'sourceCoverage': coverage, 'sourceHashes': sources,
              'recommendationOrder': RECOMMENDATIONS, 'nominationCoverage': nominations,
              'supersededConfigurations': superseded,
              'monoRetest': mono_retest,
              'ownerRetest': owner_retest,
              'retestPriorities': [item for item in priorities['candidates']
                                   if rows[item['variantId']]['recommendation'] == 'Needs more testing'],
              'counts': {'configurations': len(rows), 'removedConfigurations': original_count - len(rows),
                         'namedCloneProfiles': sum(r['generation'] == 'Bank-fitting profile' for r in rows.values()),
                         'observations': sum(o['observedPhases'] > 0 for r in rows.values() for o in r['observations']),
                         'runRecords': sum(len(r['observations']) for r in rows.values()),
                         'recommendations': dict(collections.Counter(r['recommendation'] for r in rows.values()))},
              'rows': [row for name in group_names for row in groups[name]]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    html = (ROOT / 'tools/fm1_configuration_catalogue.template.html').read_text()
    embedded = json.dumps(result, ensure_ascii=False).replace('<', '\\u003c')
    html = html.replace('__CATALOGUE_DATA__', embedded)
    (ROOT / 'web/public/fm1-configurations.html').write_text(html)
    markdown = ['# FM-1 configuration catalogue — 12 November 2026', '',
        'A configuration recommendation catalogue incorporating the recorded hardware retests, not a new bank or an importable patch. '
        'Use http://127.0.0.1:5179/fm1-configurations.html for searchable filters, more-voices comparisons, '
        'current-ceiling-only options and full per-row history. The HTML is self-contained and also opens offline.', '',
        f"**{len(rows)} configurations; {original_count - len(rows)} entries superseded by later proven same/better configurations removed.** "
        'Current means firmware `' + CURRENT + '`. Older evidence never inherits current qualification.', '',
        '**Include** = eligible audition candidate/protected source, not a request to install every duplicate. '
        '**Needs more testing** = potential configuration without complete current qualification. '
        '**Exclude** = the stated resource, guard, policy or unresolved-identity recommendation; these entries remain visible.', '',
        'Grouped by instrument, ordered by the best recommendation in each group: Include → Needs more testing → Exclude. '
        'Configurations use the same recommendation order within each group; equal-ranked groups are alphabetical. '
        'Within a recommendation, at-parity profiles prioritize more FX before extra voices.', '',
        ('**No Include nomination:** ' + ', '.join(nominations['withoutInclusion']) if nominations['withoutInclusion']
         else f"**Inclusion coverage: all {len(bank_names)} FM-1 instruments have an Include nomination.**") +
        f" {len(nominations['currentQualified'])} have current-qualified melodic profiles; "
        f"{len(nominations['protectedNotResurveyed'])} are unchanged protected entries, not freshly re-surveyed.", '',
        '**Outside the bank policy:** ' + ', '.join(nominations['outsideBankPolicy']) +
        ' are editor examples with Exclude recommendations, not missing FM-1 nominations.', '',
        'Hera distinctions: the published three-note shared-filter profile keeps independent AMP envelopes; '
        'the four-note shared-filter Chorus+Delay alternative also qualifies. The original-polyphony/native-Chorus-only '
        'three-note option is distinct; its requested retest appears below with the intended bank name Hera 3.', '',
        'Effects below are **total kinds**, including native effects. Auxiliary voices do not add played notes. '
        'For older-only rows, the peak is the worst retained older observation, not a current CPU prediction. '
        'Zero guard counts cover only tested phases; stopped runs leave the rest unknown.', '',
        '**Mono retests:** harmonizers are physically removed, not merely bypassed; Steps/Arp and original DSP remain. '
        'The status and individual results are retained in the JSON’s `monoRetest`. Harmonizer-enabled results are not '
        'silently reused as harmonizer-free qualification. Canvas byte-fit variants abbreviate display captions only. '
        f"{mono_retest['counts']['passed']} complete passes and {mono_retest['counts']['failed']} stopped failures over "
        f"{mono_retest['counts']['observedPhases']}/{mono_retest['counts']['requiredPhases']} observed phases; "
        'all three compact Canvas alternatives fit bytes but none cleared the original 95% gate in that initial batch. '
        'Later requested retests are separately identified; published bank unchanged.', '',
        '**Original-synth/FX policy:** once hardware played-note parity is reached, complete the FX rack before adding voices. '
        'Above-parity configurations without all of Drive + Chorus + Delay + Reverb are Exclude, even after a CPU pass. '
        'Original counts and mode/articulation caveats are shown per instrument; they are not the source patch allocator counts.', '',
        'Pruning is based on demonstrated supersession, never the recommendation label or a failed/unmeasured result. '
        'A replacement must have a final current-firmware complete pass, at least the same played notes and added effects, '
        'the same intrinsic effects, and no additional articulation coupling or DSP compromises. '
        'Unknown identities and current failures remain visible. Every removed ID has a replacement ID and both '
        'evidence records in `supersededConfigurations` in the JSON. Superseded runs for retained profiles remain in history.', '']
    if owner_retest:
        markdown += ['## Latest owner-requested retests', '',
            'Five-second phases; full matrices must stay below 100% with zero mute, shedding or observed late halves. '
            'This scoped interpretation treats 95% as a headroom warning, not a global policy change. '
            'Earlier stopped results remain in Sources and history. Reduced-headroom acceptances cannot prune stricter candidates.', '',
            '| Configuration | Recommendation | Observed peak | Phases | Mute / shed / late |',
            '|---|---|---:|---:|---|']
        for case in owner_retest['cases']:
            row = rows[case['variantId']]
            o = row['displayEvidence']
            markdown.append(f"| {case['label']} | {row['recommendation']}" +
                            (' — reduced headroom' if row['reducedHeadroomAcceptance'] else '') +
                            f" | {o['peakPercent']:.1f}% | {o['observedPhases']}/{o['requiredPhases']} | {o['mute']} / {o['shed']} / {o['late']} |")
        markdown.append('')
    def md(value):
        return str(value).replace('|', '\\|').replace('\n', ' ')
    source_ids = {name: f'S{index + 1}' for index, name in enumerate(sorted(sources))}
    for name in group_names:
        markdown += ['## ' + name, '',
            ', '.join(f"{count} {decision}" for decision in RECOMMENDATIONS
                      if (count := sum(r['recommendation'] == decision for r in groups[name]))), '']
        if name in parity:
            reference = parity[name]
            markdown += [f"Original: **{reference['model']} — {reference['baselineNotes']} played notes.** "
                         + reference['articulation'] + ' '
                         + ' '.join(f"[Source {index + 1}]({source['url']})"
                                    for index, source in enumerate(reference['sources'])
                                    if source['url'].startswith(('http://', 'https://'))), '']
        markdown += ['| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |',
                     '|---|---|---|---|---|']
        for row in groups[name]:
            o = row['displayEvidence']
            played = f"{row['playedNotes']} played notes" if row['playedNotes'] is not None else 'Played count unresolved'
            if row['auxiliaryVoices']:
                played += '; auxiliary ' + '+'.join(map(str, row['auxiliaryVoices']))
            fx = 'Not audited / unknown' if row['totalFx'] is None else ', '.join(row['totalFx']) or 'None'
            observed = row['evidenceScope']
            if o:
                observed += f"; {o['peakPercent']:.1f}% peak; {o['observedPhases']}/{o['requiredPhases'] or '?'} phases; "
                observed += f"mute {o['mute']}, shed {o['shed']}, late {o['late']}; [{source_ids[o['source']]}]"
            else:
                observed += '; no new hardware CPU measurement'
            markdown.append('| ' + ' | '.join(map(md, [
                '`' + row['id'] + '`' + (' (published)' if row['selected'] else ''),
                played + '; ' + row['profile'] + ('; harmonizer removed' if row.get('harmonizerRemoved') else ''),
                fx, '**' + row['recommendation'] + '** — ' + row['reason'] +
                (f" **Retest priority {row['retestPriority']['rank']}:** {row['retestPriority']['why']}" if row.get('retestPriority') else '') +
                (' Display captions abbreviated; all controls, choices and DSP retained.' if row.get('textOnlyChanges') else ''), observed])) + ' |')
        markdown.append('')
    markdown += ['## Source index', '', 'Exact per-phase results, encoding versions, hashes and record identifiers are retained in the companion JSON and expandable HTML rows.', '']
    for name in sorted(sources):
        markdown.append(f"- [{source_ids[name]}] `{name}` — SHA-256 `{sources[name]}`")
    args.output.with_suffix('.md').write_text('\n'.join(markdown) + '\n')
    print(json.dumps(result['counts'], indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=pathlib.Path, default=ROOT.parent / 'release-evidence-private/prototype-bank/fx-bus')
    parser.add_argument('--early', type=pathlib.Path, required=True)
    parser.add_argument('--articulation', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    generate(parser.parse_args())
