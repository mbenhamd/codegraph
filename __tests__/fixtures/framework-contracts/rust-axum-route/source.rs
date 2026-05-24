use axum::{routing::get, Router};

fn build_app() -> Router {
    Router::new().route("/users", get(list_users))
}
