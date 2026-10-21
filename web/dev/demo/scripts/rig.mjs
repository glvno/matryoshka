// The drums, built before the take starts (the take has two bars for each): the 909 kick and the hats assemblies, each
// switched off, with a Steps track already filled (kick 1 5 9 13; hats closed on every step but 14) and their outputs
// on the Output. On camera only the cables that matter are patched (a track onto a drum, the kick's envelope onto the
// cutoff) and the switches go on. The kick is quieter than the assembly's own level, and its card shows its amp envelope.
import { zoom } from './setup.mjs';

export const KICK_STEPS = [0, 4, 8, 12];
export const HAT_STEPS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15];

export async function rig(page, pos) {
  const add = async (btn, q, re) => {
    await page.getByRole('button', { name: btn }).click();
    await page.keyboard.type(q);
    await page.waitForTimeout(200);
    if (re) await page.locator('#palette-list li').filter({ hasText: re }).first().click();
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
  };
  await add('+ Add assembly', ' kick', /^assembly\s*kick\s*Drums/);
  await add('+ Add module', ' steps');
  await add('+ Add assembly', ' hats', /^assembly\s*hats/);
  await add('+ Add module', ' steps');
  // switched off through their own buttons (the switch remembers the members' state)
  for (const name of ['kick', 'hats']) await page.locator(`button[title^="${name} on / off"]`).first().click();
  await page.waitForTimeout(1500);   // (the app's own save of these lands first)
  await page.evaluate(({ pos, KICK_STEPS, HAT_STEPS }) => {
    const p = JSON.parse(localStorage.getItem('matryoshka.patch'));
    const asm = (n) => p.assemblies.find((a) => a.name === n);
    const kick = asm('kick'), hats = asm('hats');
    const steps = p.modules.filter((m) => m.type === 'steps');
    const [ks, hs] = steps.slice(-2);
    const out = p.modules.find((m) => m.type === 'output');
    const ampEnv = p.modules.find((m) => kick.modules.includes(m.id) && m.type === 'env' && m.params.l2 === 0.5 && m.params.r2 === 0.12);
    const shaper = p.modules.find((m) => kick.modules.includes(m.id) && m.type === 'shape');
    shaper.params.level = 0.55;
    kick.outputs.push({ module: ampEnv.id, port: 'env', label: 'env' });
    ks.steps = Array.from({ length: 64 }, (_, k) => (KICK_STEPS.includes(k) ? 1 : 0));
    hs.steps = Array.from({ length: 64 }, (_, k) => (HAT_STEPS.includes(k) ? 1 : 0));
    for (const a of [kick, hats]) {
      const o = a.outputs[0];
      for (const port of ['l', 'r']) p.cables.push({ from: { module: o.module, port: o.port }, to: { module: out.id, port } });
    }
    Object.assign(kick, pos.kick); Object.assign(ks, pos.ks); Object.assign(hats, pos.hats); Object.assign(hs, pos.hs);
    localStorage.setItem('matryoshka.patch', JSON.stringify(p));
  }, { pos, KICK_STEPS, HAT_STEPS });
  await page.reload();
  await page.waitForTimeout(1500);
  await zoom(page);
}
