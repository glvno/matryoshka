//! Reading text off the emulated LCD: the firmware's own 5x7 font (firmware/src/font5x7.c,
//! parsed at compile time) drawn as `text_dots` draws it, and searched for in the frame.
//! `text_dots` paints a solid block (n characters x `3 * size2` px, `(7 * size2 + 1) / 2`
//! rows) in exactly two colours, so a match is exact: every set dot one colour, every other
//! pixel of the block another.

use std::sync::OnceLock;

const SRC: &str = include_str!("../../../firmware/src/font5x7.c");
const W: usize = 240;
const H: usize = 240;

fn font() -> &'static Vec<[u8; 5]> {
    static F: OnceLock<Vec<[u8; 5]>> = OnceLock::new();
    F.get_or_init(|| {
        let body = &SRC[SRC.find("FONT5X7[").expect("FONT5X7 in font5x7.c")..];
        let body = &body[..body.find("};").unwrap()];
        let mut out = Vec::new();
        for line in body.lines().skip(1) {
            let line = line.split("/*").next().unwrap();
            let v: Vec<u8> = line
                .split(|c: char| !c.is_ascii_alphanumeric())
                .filter_map(|t| t.strip_prefix("0x").and_then(|h| u8::from_str_radix(h, 16).ok()))
                .collect();
            if v.len() == 5 {
                out.push([v[0], v[1], v[2], v[3], v[4]]);
            }
        }
        assert_eq!(out.len(), 59, "font5x7.c: 59 glyphs");
        out
    })
}

/// The block `text_dots(s, size2)` draws: true where the foreground goes.
pub fn render(s: &str, size2: usize) -> (usize, usize, Vec<bool>) {
    let cell = 3 * size2;
    let gw = (5 * size2 + 1) / 2;
    let gh = (7 * size2 + 1) / 2;
    let n = s.chars().count();
    let w = n * cell;
    let mut px = vec![false; w * gh];
    for (c, ch) in s.chars().enumerate() {
        let mut ch = ch as u32;
        if (b'a' as u32..=b'z' as u32).contains(&ch) {
            ch -= 32;
        }
        if !(0x20..=0x5a).contains(&ch) {
            ch = 0x20;
        }
        let g = font()[(ch - 0x20) as usize];
        for r in 0..gh {
            for k in 0..gw {
                if (g[k * 2 / size2] >> (r * 2 / size2)) & 1 != 0 {
                    px[r * w + c * cell + k] = true;
                }
            }
        }
    }
    (w, gh, px)
}

/// Where `s` is on the screen at size `size2` (2 = 1x, 3 = 1.5x, 4 = 2x): (x, y, fg, bg).
/// Trailing cells may run past the right edge (the firmware clips at 240 px).
pub fn find(fb: &[u16], s: &str, size2: usize) -> Option<(usize, usize, u16, u16)> {
    let (w, h, px) = render(s, size2);
    let first = px.iter().position(|&b| b)?;
    let (fy, fx) = (first / w, first % w);
    for y in 0..=H.saturating_sub(h) {
        'x: for x in 0..W {
            let ww = w.min(W - x);
            if ww < w && ww < w - 3 * size2 {
                continue; // more than the last cell clipped
            }
            if fx >= ww {
                continue;
            }
            let fg = fb[(y + fy) * W + x + fx];
            let mut bg: Option<u16> = None;
            for r in 0..h {
                for c in 0..ww {
                    let p = fb[(y + r) * W + x + c];
                    if px[r * w + c] {
                        if p != fg {
                            continue 'x;
                        }
                    } else {
                        match bg {
                            None if p != fg => bg = Some(p),
                            None => continue 'x,
                            Some(b) if b != p => continue 'x,
                            _ => {}
                        }
                    }
                }
            }
            if let Some(b) = bg {
                return Some((x, y, fg, b));
            }
        }
    }
    None
}

/// `s` at any of the firmware's sizes (1x, 1.5x, 2x, 3x, 4x).
pub fn on_screen(fb: &[u16], s: &str) -> bool {
    [2, 3, 4, 6, 8].iter().any(|&z| find(fb, s, z).is_some())
}
