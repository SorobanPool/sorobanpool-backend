use crate::AppState;
use axum::extract::State;
use axum::http::StatusCode;

pub async fn health() -> &'static str {
    "ok"
}

pub async fn ready(State(state): State<AppState>) -> StatusCode {
    match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => StatusCode::OK,
        Err(_) => StatusCode::SERVICE_UNAVAILABLE,
    }
}
