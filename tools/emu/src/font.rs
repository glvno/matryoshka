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

/// `s` at any of the firmware's sizes (1x, 1.5x, 2x, 3x, 4x), or in the brand type (font_bc.c) at any of its sizes.
pub fn on_screen(fb: &[u16], s: &str) -> bool {
    [2, 3, 4, 6, 8].iter().any(|&z| find(fb, s, z).is_some()) || (0..bc_fonts().len()).any(|f| find_bc(fb, s, f).is_some())
}

// ---- the brand type: firmware/src/font_bc.h (tools/gen_font.py), 4-bit coverage blended from paper to ink. A glyph's
// fully covered pixels are the ink, its empty ones the paper; the blended edge pixels are left out of the match.

const BC: &str = include_str!("../../../firmware/src/font_bc.h");

pub struct BcFont {
    h: usize,
    map: Vec<u8>,
    glyphs: Vec<(usize, usize, i32, usize)>, // ink width, advance, ink start, offset into bits
    bits: Vec<u8>,
}

fn numbers(body: &str) -> Vec<i64> {
    body.split(|c: char| !(c.is_ascii_digit() || c == '-'))
        .filter(|t| !t.is_empty() && t != &"-")
        .filter_map(|t| t.parse().ok())
        .collect()
}

fn array<'a>(name: &str) -> &'a str {
    let start = BC.find(&format!("{name}[")).unwrap_or_else(|| panic!("{name} in font_bc.h"));
    let body = &BC[start..];
    let open = body.find('{').unwrap();
    let close = body.find("};").unwrap();
    &body[open + 1..close]
}

pub fn bc_fonts() -> &'static Vec<BcFont> {
    static F: OnceLock<Vec<BcFont>> = OnceLock::new();
    F.get_or_init(|| {
        let mut out = Vec::new();
        // every size font_bc.h has (tools/gen_font.py), in its order
        let names: Vec<&str> = BC
            .match_indices("static const font_t ")
            .map(|(i, m)| {
                let rest = &BC[i + m.len()..];
                &rest[..rest.find(' ').unwrap()]
            })
            .collect();
        for name in names {
            let l = name.to_lowercase();
            let head = &BC[BC.find(&format!("static const font_t {name} = {{")).unwrap_or_else(|| panic!("{name}"))..];
            let h = numbers(&head[..head.find('}').unwrap()])[0] as usize;
            let map: Vec<u8> = numbers(array(&format!("{l}_map"))).into_iter().map(|v| v as u8).collect();
            let g = numbers(array(&format!("{l}_g")));
            let glyphs = g.chunks(4).map(|c| (c[0] as usize, c[1] as usize, c[2] as i32, c[3] as usize)).collect();
            let bits = numbers(array(&format!("{l}_bits"))).into_iter().map(|v| v as u8).collect();
            out.push(BcFont { h, map, glyphs, bits });
        }
        out
    })
}

/// The block `text_bc` draws for `s` in font `f`: coverage 0..15 per pixel (left aligned, as wide as the text).
pub fn render_bc(s: &str, f: usize) -> (usize, usize, Vec<u8>) {
    let font = &bc_fonts()[f];
    let gl = |c: char| -> Option<&(usize, usize, i32, usize)> {
        let c = c as u32;
        if !(0x20..0x7f).contains(&c) {
            return None;
        }
        let g = font.map[(c - 0x20) as usize];
        (g != 255).then(|| &font.glyphs[g as usize])
    };
    let w: usize = s.chars().filter_map(gl).map(|g| g.1).sum();
    let mut px = vec![0u8; w * font.h];
    let mut x = 0usize;
    for c in s.chars() {
        let Some(&(gw, adv, gx, off)) = gl(c) else { continue };
        let rb = (gw + 1) / 2;
        for r in 0..font.h {
            for j in 0..gw {
                let b = font.bits[off + r * rb + j / 2];
                let a = if j % 2 == 1 { b & 15 } else { b >> 4 };
                let at = x as i32 + j as i32 + gx;
                if a > 0 && at >= 0 && (at as usize) < w {
                    px[r * w + at as usize] = a;
                }
            }
        }
        x += adv;
    }
    (w, font.h, px)
}

/// Where `s` is on the screen in brand font `f`: (x, y, fg, bg). The line box may run up to 3 rows past the screen's
/// bottom (the footer's type: its descenders' rows are not drawn), as long as no ink falls there.
pub fn find_bc(fb: &[u16], s: &str, f: usize) -> Option<(usize, usize, u16, u16)> {
    let (w, h, px) = render_bc(s, f);
    if w == 0 || w > W || h > H {
        return None;
    }
    let first = px.iter().position(|&a| a == 15)?;
    let empty = px.iter().position(|&a| a == 0)?;
    let ink_rows = px.chunks(w).rposition(|row| row.iter().any(|&a| a != 0)).map_or(h, |r| r + 1);
    for y in 0..=H - h.min(ink_rows).max(1) {
        if y + h > H + 3 || y + ink_rows > H || y + empty / w >= H {
            continue;
        }
        'x: for x in 0..=W - w {
            let fg = fb[(y + first / w) * W + x + first % w];
            let bg = fb[(y + empty / w) * W + x + empty % w];
            if fg == bg {
                continue;
            }
            for r in 0..h.min(H - y) {
                for c in 0..w {
                    let p = fb[(y + r) * W + x + c];
                    match px[r * w + c] {
                        15 if p != fg => continue 'x,
                        0 if p != bg => continue 'x,
                        _ => {}
                    }
                }
            }
            return Some((x, y, fg, bg));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brand_type_parses() {
        let f = bc_fonts();
        assert!(f.len() >= 4);
        assert_eq!(f[0].map.len(), 95);
        let (w, h, px) = render_bc("OCT 0", 0);
        assert!(w > 10 && h == f[0].h && px.iter().any(|&a| a == 15));
    }

    /// against the LCD preview (tools/ui_preview.sh writes build/ui_preview.ppm): run it first
    #[test]
    #[ignore]
    fn finds_text_on_the_preview() {
        let d = std::fs::read("../../build/ui_preview.ppm").expect("build/ui_preview.ppm");
        let px = &d[d.len() - W * H * 3..];
        let fb: Vec<u16> = px.chunks(3).map(|c| {
            let r = (c[0] as u32 * 31 + 127) / 255;
            let g = (c[1] as u32 * 63 + 127) / 255;
            let b = (c[2] as u32 * 31 + 127) / 255;
            (r << 11 | g << 5 | b) as u16
        }).collect();
        assert!(on_screen(&fb, "= OCT ="), "the footer's octave");
        assert!(on_screen(&fb, "ORACLE V"), "the patch's name");
        assert!(!on_screen(&fb, "NOT THERE"));
    }
}
