use reqwest::{Response, StatusCode};
use std::future::Future;
use std::time::Duration;

pub const MAX_RETRIES: u32 = 2;
const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

pub fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

pub fn retry_delay(retry_index: u32) -> Duration {
    INITIAL_BACKOFF
        .checked_mul(2_u32.saturating_pow(retry_index))
        .unwrap_or(MAX_BACKOFF)
        .min(MAX_BACKOFF)
}

pub async fn send_with_retry<F, Fut>(provider: &str, mut send: F) -> reqwest::Result<Response>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = reqwest::Result<Response>>,
{
    let mut retries = 0;

    loop {
        let response = send().await?;
        let status = response.status();
        if !is_retryable_status(status) || retries >= MAX_RETRIES {
            return Ok(response);
        }

        let delay = retry_delay(retries);
        retries += 1;
        tracing::warn!(
            provider,
            status = status.as_u16(),
            retry_attempt = retries,
            max_retries = MAX_RETRIES,
            delay_seconds = delay.as_secs(),
            "Retrying provider request after transient HTTP response"
        );
        tokio::time::sleep(delay).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_only_rate_limits_and_server_errors() {
        assert!(is_retryable_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(is_retryable_status(StatusCode::INTERNAL_SERVER_ERROR));
        assert!(is_retryable_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(!is_retryable_status(StatusCode::BAD_REQUEST));
        assert!(!is_retryable_status(StatusCode::UNAUTHORIZED));
        assert!(!is_retryable_status(StatusCode::OK));
    }

    #[test]
    fn exponential_backoff_is_capped_at_thirty_seconds() {
        assert_eq!(retry_delay(0), Duration::from_secs(1));
        assert_eq!(retry_delay(1), Duration::from_secs(2));
        assert_eq!(retry_delay(2), Duration::from_secs(4));
        assert_eq!(retry_delay(5), Duration::from_secs(30));
        assert_eq!(retry_delay(31), Duration::from_secs(30));
    }
}
