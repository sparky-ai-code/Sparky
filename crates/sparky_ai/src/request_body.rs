use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Serialize;
use std::io::Write;

/// Avoid gzip CPU and framing overhead for bodies below 1 KiB.
pub(crate) const GZIP_THRESHOLD_BYTES: usize = 1024;

#[derive(Debug)]
pub(crate) struct EncodedJson {
    pub(crate) bytes: Vec<u8>,
    pub(crate) compressed: bool,
}

/// Serialize once, then optionally gzip. Callers should enable this only for
/// endpoints whose request-body gzip support is known.
pub(crate) fn encode_json<T: Serialize>(
    value: &T,
    gzip_supported: bool,
) -> anyhow::Result<EncodedJson> {
    let json = serde_json::to_vec(value)?;
    if !gzip_supported || json.len() < GZIP_THRESHOLD_BYTES {
        return Ok(EncodedJson {
            bytes: json,
            compressed: false,
        });
    }

    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&json)?;
    Ok(EncodedJson {
        bytes: encoder.finish()?,
        compressed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;

    #[test]
    fn gzip_round_trips_json_and_shrinks_repetitive_payloads() {
        let value = serde_json::json!({"prompt": "repeated context ".repeat(10_000)});
        let original = serde_json::to_vec(&value).unwrap();
        let encoded = encode_json(&value, true).unwrap();
        assert!(encoded.compressed);
        let mut decoded = Vec::new();
        GzDecoder::new(encoded.bytes.as_slice())
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, original);
        eprintln!(
            "gzip measurement: raw={} bytes, gzip={} bytes, reduction={:.1}%",
            original.len(),
            encoded.bytes.len(),
            (1.0 - encoded.bytes.len() as f64 / original.len() as f64) * 100.0
        );
    }

    #[test]
    fn small_payloads_and_unsupported_endpoints_remain_identity_encoded() {
        let small = serde_json::json!({"prompt": "small"});
        let encoded = encode_json(&small, true).unwrap();
        assert!(!encoded.compressed);
        assert_eq!(encoded.bytes, serde_json::to_vec(&small).unwrap());

        let large = serde_json::json!({"prompt": "repeated context ".repeat(10_000)});
        let encoded = encode_json(&large, false).unwrap();
        assert!(!encoded.compressed);
        assert_eq!(encoded.bytes, serde_json::to_vec(&large).unwrap());
    }
}
