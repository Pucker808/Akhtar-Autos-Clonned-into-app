use super::support::TempDir;
use serde_json::Value;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;

fn substitute(value: &mut Value, dir: &str) {
    match value {
        Value::String(s) => *s = s.replace("$DIR", dir),
        Value::Array(items) => items.iter_mut().for_each(|v| substitute(v, dir)),
        Value::Object(map) => map.values_mut().for_each(|v| substitute(v, dir)),
        _ => {}
    }
}

#[test]
fn frontend_ipc_contract_is_accepted_by_the_real_commands() {
    let app = crate::with_commands(mock_builder())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let dir = TempDir::new();
    let mut calls: Vec<Value> =
        serde_json::from_str(include_str!("../../tests/fixtures/ipc-contract.json")).unwrap();
    assert!(calls.len() >= 19);

    for call in &mut calls {
        substitute(call, &dir.root().replace('\\', "/"));
        let command = call["cmd"].as_str().unwrap().to_string();
        let response = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: command.clone(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: InvokeBody::Json(call["args"].clone()),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        );
        assert!(response.is_ok(), "{command}: {:?}", response.err());
    }
}
