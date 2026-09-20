//! The hash every stage and every interface uses.
//!
//! §14.1 binds inspection, remediation and verification to one file by its
//! hash, and §12 gives three interfaces that all have to produce the same
//! result for the same bytes. A hash computed in each of them is three
//! implementations of one fact.
//!
//! The JavaScript reference implementation in `tools/file-identity.mjs` holds
//! the ordering property - bytes are unreachable except through a record that
//! has already hashed them - and that structure is #62's to port. This is the
//! primitive underneath it.

use sha2::{Digest, Sha256};

/// Lowercase hex, which is the spelling `common.schema.json` requires.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two vectors everybody knows, so a wrong digest is wrong here rather
    /// than in a result nobody can check by eye.
    #[test]
    fn the_published_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn the_spelling_the_schema_requires() {
        let hex = sha256_hex(b"anything");
        assert_eq!(hex.len(), 64);
        assert!(hex
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }
}
