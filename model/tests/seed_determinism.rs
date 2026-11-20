//! Cross-platform determinism suite for the reference model's seed expansion.
//!
//! The differential harness and the fuzz campaigns rely on the same seed
//! producing the same action bytes on every platform. These tests pin the
//! expansion output (`model/goldens/seed_expansion.txt`), cover every public
//! generator, and include a perturbed-expansion self-test that must fail the
//! golden comparison.
//!
//! Bless procedure (from the repo root):
//!   npm run seed:golden:bless
//! Re-blessing is only correct for an intentional change to the contract, and
//! must bump `SEED_EXPANSION_VERSION` and explain the change in the PR.

use streampay_model::seeds::{
    all_seeded_scenarios, generate_sequence, generate_sequence_with_rng, SeedExpander,
    GENERATED_SEQUENCE_LEN, SEED_EXPANSION_VERSION,
};

const GOLDEN_REL: &str = "goldens/seed_expansion.txt";
const BLESS_ENV: &str = "STREAMPAY_SEED_GOLDEN_BLESS";

/// Committed seeds for the generated-sequence goldens.
const GENERATED_SEEDS: [u64; 5] = [0, 1, 2, 42, 0x00C0_FFEE];

fn golden_path() -> std::path::PathBuf {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.join(GOLDEN_REL)
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// The first four expanded words for `seed`, comma separated, big-endian hex
/// text (the numeric value, not its byte encoding).
fn expansion_words(seed: u64) -> String {
    let mut expander = SeedExpander::new(seed);
    let words: Vec<String> = (0..4)
        .map(|_| format!("{:016x}", expander.next_u64()))
        .collect();
    words.join(",")
}

/// Builds the exact committed golden document.
fn golden_document() -> String {
    let mut out = String::new();
    out.push_str("# StreamPay reference model: seed-expansion golden vectors.\n");
    out.push_str("# Generated, do not hand-edit. Re-bless with `npm run seed:golden:bless`.\n");
    out.push_str("# See model/SEED_EXPANSION.md for the frozen contract.\n");
    out.push_str("#\n");
    out.push_str(
        "# label|seed|first 4 expanded u64s (big-endian hex)|ActionSequence::to_bytes hex\n",
    );
    out.push_str(&format!("version|{SEED_EXPANSION_VERSION}\n"));

    // Every public fixed generator, serialized through the same encoding the
    // differential corpus uses.
    for (name, sequence) in all_seeded_scenarios() {
        out.push_str(&format!(
            "fixed/{name}|0|{}|{}\n",
            expansion_words(0),
            hex(&sequence.to_bytes())
        ));
    }

    // The seeded generator at each committed seed.
    for seed in GENERATED_SEEDS {
        let sequence = generate_sequence(seed);
        assert_eq!(
            sequence.actions.len(),
            GENERATED_SEQUENCE_LEN,
            "generate_sequence must emit the frozen length"
        );
        out.push_str(&format!(
            "generated/{seed}|{seed}|{}|{}\n",
            expansion_words(seed),
            hex(&sequence.to_bytes())
        ));
    }
    out
}

fn read_stored() -> String {
    let path = golden_path();
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|_| {
        panic!(
            "{} does not exist. Run 'npm run seed:golden:bless' to create it.",
            path.display()
        )
    });
    // Normalise CRLF so a Windows checkout cannot change the outcome.
    raw.replace("\r\n", "\n")
}

#[test]
fn seed_expansion_goldens_match() {
    let generated = golden_document();

    if std::env::var(BLESS_ENV).as_deref() == Ok("1") {
        let path = golden_path();
        std::fs::create_dir_all(path.parent().expect("goldens dir")).expect("create goldens dir");
        std::fs::write(&path, &generated).expect("write blessed seed_expansion.txt");
        println!("Blessed seed-expansion goldens: {}", path.display());
        return;
    }

    let stored = read_stored();
    assert_eq!(
        stored, generated,
        "\n====================================================================\n\
         SEED-EXPANSION GOLDEN MISMATCH\n\
         ====================================================================\n\
         The reference model no longer expands committed seeds into the same\n\
         ActionSequence bytes. Differential/fuzz failures would no longer be\n\
         reproducible across platforms.\n\n\
         If the change is intentional:\n\
           1. Bump SEED_EXPANSION_VERSION in model/src/seeds.rs.\n\
           2. Run 'npm run seed:golden:bless' and review the fixture diff.\n\
           3. Explain the change in the PR description.\n\
         ====================================================================\n"
    );
}

/// The goldens must cover every public generator, not just a sample.
#[test]
fn goldens_cover_every_public_generator() {
    let stored = read_stored();
    let fixed = all_seeded_scenarios();
    assert_eq!(fixed.len(), 14, "all fixed scenarios must be golden-pinned");
    for (name, _) in &fixed {
        assert!(
            stored.contains(&format!("fixed/{name}|")),
            "missing golden row for public generator {name}"
        );
    }
    for seed in GENERATED_SEEDS {
        assert!(
            stored.contains(&format!("generated/{seed}|")),
            "missing golden row for generated seed {seed}"
        );
    }
}

/// The expander is reproducible from the same seed, and the version is frozen.
#[test]
fn expander_is_reproducible_and_versioned() {
    assert_eq!(SEED_EXPANSION_VERSION, 1);

    let mut a = SeedExpander::new(0xDEAD_BEEF);
    let mut b = SeedExpander::new(0xDEAD_BEEF);
    for _ in 0..64 {
        assert_eq!(a.next_u64(), b.next_u64());
    }

    // First SplitMix64 output for seed 0 — pinned independently of the fixture.
    let mut zero = SeedExpander::new(0);
    assert_eq!(zero.next_u64(), 0xE220_A839_7B1D_CDAF);

    // The 32-bit stream is the high half of the 64-bit stream, not a fresh mix.
    let mut wide = SeedExpander::new(7);
    let mut narrow = SeedExpander::new(7);
    assert_eq!(narrow.next_u32(), (wide.next_u64() >> 32) as u32);
}

/// The seed's canonical byte encoding is frozen as little-endian.
#[test]
fn seed_bytes_are_little_endian() {
    assert_eq!(
        SeedExpander::seed_bytes(0x0102_0304_0506_0708),
        [8, 7, 6, 5, 4, 3, 2, 1]
    );
}

/// One deliberately perturbed mix step (a different shift) must produce a
/// different sequence, so the suite really compares against the goldens.
#[test]
fn perturbed_seed_expansion_fails_the_golden_comparison() {
    struct Perturbed(u64);

    impl Perturbed {
        fn next_u64(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            // Perturbation: shift 29 instead of the contractual 30.
            z = (z ^ (z >> 29)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }
    }

    let seed = 42;
    let expected = generate_sequence(seed).to_bytes();

    let mut perturbed = Perturbed(seed);
    let perturbed =
        generate_sequence_with_rng(|| perturbed.next_u64(), GENERATED_SEQUENCE_LEN).to_bytes();
    assert_ne!(
        perturbed, expected,
        "perturbing the expansion must change the generated sequence"
    );

    // And that different output must not match the committed golden row.
    let stored = read_stored();
    let row = stored
        .lines()
        .find(|line| line.starts_with(&format!("generated/{seed}|")))
        .expect("golden row for the perturbed seed");
    let stored_hex = row
        .split('|')
        .nth(3)
        .expect("sequence column in the golden row");
    assert_ne!(
        hex(&perturbed),
        stored_hex,
        "perturbed expansion must fail the golden comparison"
    );
}
