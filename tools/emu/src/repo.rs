//! The checkout's files m1emu reads (the factory region, firmware headers), read when it runs and never compiled in:
//! worktrees share one tools/emu/target (D-074), so a copy compiled in is the one of whichever checkout built the binary
//! last, and cargo does not rebuild for another checkout's changed file (#1205: kit-fold's firmware ran on main's
//! factory region). The checkout is the nearest directory at or above the working directory holding
//! tools/emu/Cargo.toml; `--factory FILE` names the factory region's image instead of its
//! web/public/firmware/matryoshka-factory.bin.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, OnceLock};

static FACTORY: OnceLock<PathBuf> = OnceLock::new();

/// The checkout m1emu runs in
static ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    let cwd = std::env::current_dir().expect("the working directory");
    cwd.ancestors()
        .find(|d| d.join("tools/emu/Cargo.toml").is_file())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| panic!("{}: not in a checkout (no tools/emu/Cargo.toml at or above it): run m1emu from the checkout", cwd.display()))
});

fn read(p: &Path) -> Vec<u8> {
    std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// A text file of the checkout, `path` from its root (firmware/src/presets.h)
pub fn text(path: &str) -> String {
    String::from_utf8(read(&ROOT.join(path))).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// `--factory FILE`: the factory region's image (before its first use)
pub fn set_factory(path: PathBuf) {
    FACTORY.set(path).expect("the factory region is named once");
}

/// The factory region's image (`--factory`, else the checkout's web/public/firmware/matryoshka-factory.bin), its
/// header said on stderr (firmware/src/factory.c: magic "MFC1", u8 layout at 4, u16 version at 6, u32 set at 8, u16
/// patches at 20)
pub fn factory() -> Vec<u8> {
    let p = FACTORY.get_or_init(|| ROOT.join("web/public/firmware/matryoshka-factory.bin"));
    let img = read(p);
    assert!(img.len() >= 64 && &img[..4] == b"MFC1", "{}: not a factory image (no MFC1 header)", p.display());
    let u16_at = |a: usize| u16::from_le_bytes([img[a], img[a + 1]]);
    eprintln!("factory region: {} (layout {}, version {}, set {:06x}, {} patches)", p.display(), img[4], u16_at(6),
        u32::from_le_bytes(img[8..12].try_into().unwrap()), u16_at(20));
    img
}
