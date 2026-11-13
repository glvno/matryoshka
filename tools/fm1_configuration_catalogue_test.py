#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Offline recommendation/supersession regressions; no hardware or retained build inputs."""
import unittest

from fm1_configuration_catalogue import FX, _scoped_retest, apply_polyphony_policy, shortlist


def configuration(id, notes=4, fx=(), *, current=False, passed=False,
                  decision='Needs more testing', mode=None, measured=True, changes=()):
    return {'id': id, 'instrument': 'Example', 'playedNotes': notes,
            'allocations': [{'module': 7, 'voices': notes}], 'paraphony': mode,
            'addedFx': list(fx), 'nativeFx': [], 'totalFx': list(fx),
            'qualityChanges': list(changes), 'selected': False, 'protected': False,
            'recommendation': decision,
            'evidenceScope': 'Current' if current else 'Older only' if measured else 'Prepared only',
            'observations': [{'source': id + '-hardware.json', 'record': id,
                              'current': current, 'passed': passed, 'observedPhases': 8 if passed else 1}]
                            if measured else []}


class Supersession(unittest.TestCase):
    def test_distinct_exclusion_and_unmeasured_option_are_not_deleted(self):
        rejected = configuration('reverb-rejected', fx=['reverb'], decision='Exclude')
        unmeasured = configuration('unmeasured-chorus', fx=['chorus'], measured=False)
        replacement = configuration('later-delay', fx=['delay'], current=True, passed=True, decision='Include')
        kept, removed = shortlist([rejected, unmeasured, replacement])
        self.assertEqual({r['id'] for r in kept}, {'reverb-rejected', 'unmeasured-chorus', 'later-delay'})
        self.assertEqual(removed, {})

    def test_same_or_better_final_pass_replaces_older_failed_profile_with_trace(self):
        old = configuration('older-failed', notes=3, fx=['delay'], decision='Exclude')
        later = configuration('later-full', fx=FX, current=True, passed=True, decision='Include')
        kept, removed = shortlist([old, later])
        self.assertEqual([r['id'] for r in kept], ['later-full'])
        self.assertEqual(removed['older-failed']['replacementId'], 'later-full')
        self.assertEqual(removed['older-failed']['earlierEvidence'][0]['source'], 'older-failed-hardware.json')
        self.assertEqual(removed['older-failed']['replacementEvidence'][0]['source'], 'later-full-hardware.json')

    def test_more_notes_or_independent_filters_are_real_tradeoffs(self):
        more_notes = configuration('eight-notes', notes=8, decision='Exclude')
        independent = configuration('independent-filters', notes=3)
        shared = configuration('shared-four', fx=FX, current=True, passed=True,
                               decision='Include', mode='shared-filter')
        kept, removed = shortlist([more_notes, independent, shared])
        self.assertEqual({r['id'] for r in kept}, {'eight-notes', 'independent-filters', 'shared-four'})
        self.assertEqual(removed, {})

    def test_partial_current_run_cannot_replace_old_configuration(self):
        old = configuration('older-failure', decision='Exclude')
        partial = configuration('current-partial', fx=FX, current=True)
        kept, removed = shortlist([old, partial])
        self.assertEqual({r['id'] for r in kept}, {'older-failure', 'current-partial'})
        self.assertEqual(removed, {})

    def test_current_failure_is_not_hidden_by_another_current_pass(self):
        failed = configuration('current-failure', current=True, decision='Exclude')
        passed = configuration('current-pass', fx=FX, current=True, passed=True, decision='Include')
        kept, removed = shortlist([failed, passed])
        self.assertEqual({r['id'] for r in kept}, {'current-failure', 'current-pass'})
        self.assertEqual(removed, {})

    def test_original_dsp_pass_supersedes_older_compromise_not_the_reverse(self):
        compromise = configuration('old-compromise', changes=[{'module': 3, 'param': 'analog', 'to': 0}])
        original = configuration('current-original', current=True, passed=True, decision='Include')
        kept, removed = shortlist([compromise, original])
        self.assertEqual([r['id'] for r in kept], ['current-original'])
        self.assertEqual(removed['old-compromise']['replacementId'], 'current-original')
        older_original = configuration('older-original')
        later_compromise = configuration('later-compromise', current=True, passed=True, decision='Include',
                                          changes=[{'module': 3, 'param': 'analog', 'to': 0}])
        kept, removed = shortlist([older_original, later_compromise])
        self.assertEqual({r['id'] for r in kept}, {'older-original', 'later-compromise'})
        self.assertEqual(removed, {})

    def test_harmonizer_removal_is_not_silently_treated_as_same_functionality(self):
        old = configuration('with-harmonizer', decision='Exclude')
        changed = configuration('without-harmonizer', fx=FX, current=True, passed=True, decision='Include')
        changed['harmonizerRemoved'] = True
        kept, removed = shortlist([old, changed])
        self.assertEqual({r['id'] for r in kept}, {'with-harmonizer', 'without-harmonizer'})
        self.assertEqual(removed, {})

    def test_relaxed_headroom_pass_cannot_prune_stricter_candidates(self):
        old = configuration('strict-old')
        relaxed = configuration('owner-exception', fx=FX, current=True, passed=True, decision='Include')
        relaxed['reducedHeadroomAcceptance'] = True
        kept, removed = shortlist([old, relaxed])
        self.assertEqual({r['id'] for r in kept}, {'strict-old', 'owner-exception'})
        self.assertEqual(removed, {})


class ScopedOwnerRetest(unittest.TestCase):
    source = 'owner-five-hardware.json'
    policy = {'id': 'owner-five-complete-clean-under100', 'scope': ['requested']}

    def candidate(self, percent=96.5):
        row = configuration('requested', current=True)
        row['observations'] = [{
            'source': self.source, 'current': True, 'passed': percent <= 95,
            'recordedPolicyPassed': True, 'recordedPolicyId': self.policy['id'],
            'complete': True, 'cleanObserved': True, 'peakPercent': percent,
            'observedPhases': 4, 'requiredPhases': 4,
            'phases': [{'id': str(i), 'passed': True, 'completedSampling': True, 'seconds': 5.2} for i in range(4)]}]
        return row

    def test_complete_approved_retest_uses_latest_evidence_without_erasing_history(self):
        for percent in (94.5, 96.5):
            with self.subTest(percent=percent):
                row = self.candidate(percent)
                old = dict(row['observations'][0], source='earlier-hardware.json', passed=False, complete=False, peakPercent=99)
                row['observations'].insert(0, old)
                result = _scoped_retest(row, self.source, self.policy)
                self.assertTrue(result['accepted'])
                self.assertEqual(result['strict95Passed'], percent <= 95)
                self.assertEqual(result['observation']['peakPercent'], percent)
                self.assertIs(row['observations'][0], old)

    def test_partial_guarded_deadline_or_shortened_retests_do_not_qualify(self):
        for fault in ('partial', 'guard', 'deadline', 'short', 'duplicate-phase', 'failed'):
            with self.subTest(fault=fault):
                row = self.candidate()
                o = row['observations'][0]
                if fault == 'partial':
                    o['complete'] = False
                elif fault == 'guard':
                    o['cleanObserved'] = False
                elif fault == 'deadline':
                    o['peakPercent'] = 100
                elif fault == 'short':
                    o['phases'][0]['seconds'] = 1
                elif fault == 'duplicate-phase':
                    o['phases'][0]['id'] = o['phases'][1]['id']
                else:
                    o['recordedPolicyPassed'] = False
                self.assertFalse(_scoped_retest(row, self.source, self.policy)['accepted'])

    def test_acceptance_is_not_global_or_an_older_firmware_promotion(self):
        row = self.candidate()
        self.assertIsNone(_scoped_retest(row, self.source, {**self.policy, 'scope': ['different']}))
        self.assertIsNone(_scoped_retest(row, 'different-hardware.json', self.policy))
        row['observations'][0]['current'] = False
        self.assertIsNone(_scoped_retest(row, self.source, self.policy))


class PolyphonyPolicy(unittest.TestCase):
    reference = {'model': 'Original mono', 'baselineNotes': 1, 'articulation': 'Monophonic'}

    def test_extra_notes_with_partial_rack_are_excluded_by_policy_even_after_cpu_pass(self):
        row = configuration('extra-notes', notes=2, fx=['drive', 'delay'], current=True, passed=True, decision='Include')
        self.assertTrue(apply_polyphony_policy(row, self.reference))
        self.assertEqual(row['originalSynth']['baselineNotes'], 1)
        self.assertFalse(row['fullFxRack'])

    def test_extra_notes_are_allowed_only_after_full_rack(self):
        row = configuration('extra-with-full-rack', notes=2, fx=FX)
        self.assertFalse(apply_polyphony_policy(row, self.reference))
        self.assertTrue(row['fullFxRack'])

    def test_at_parity_prefers_more_effects_without_automatic_exclusion(self):
        lean = configuration('at-parity-lean', notes=1, fx=['delay'])
        fuller = configuration('at-parity-fuller', notes=1, fx=['delay', 'reverb'])
        self.assertFalse(apply_polyphony_policy(lean, self.reference))
        self.assertFalse(apply_polyphony_policy(fuller, self.reference))
        self.assertGreater(fuller['fxPreference'], lean['fxPreference'])

    def test_unknown_fx_or_reference_is_not_invented_as_a_policy_failure(self):
        row = configuration('unknown', notes=2)
        row['totalFx'] = None
        self.assertFalse(apply_polyphony_policy(row, self.reference))
        self.assertIsNone(row['fullFxRack'])
        self.assertFalse(apply_polyphony_policy(row, None))


if __name__ == '__main__':
    unittest.main()
