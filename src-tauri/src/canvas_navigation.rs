//! Let live canvas iframes navigate without relaxing the main app's policy.
use block2::DynBlock;
use objc2::{msg_send, runtime::{AnyClass, AnyObject, ClassBuilder, Sel}, sel};
use objc2_web_kit::{WKNavigationAction, WKNavigationActionPolicy, WKWebView};
use std::sync::OnceLock;
use tauri::Webview;
use tokio::sync::oneshot;

static DELEGATE_CLASS: OnceLock<&'static AnyClass> = OnceLock::new();

fn embedded_policy(main_frame: Option<bool>, scheme: Option<&str>) -> Option<WKNavigationActionPolicy> {
    // A missing target denotes a new window. Wry must retain ownership of it,
    // just as it retains the existing policy for every top-level navigation.
    if main_frame != Some(false) { return None; }
    Some(if matches!(scheme, Some("http" | "https")) {
        WKNavigationActionPolicy::Allow
    } else {
        WKNavigationActionPolicy::Cancel
    })
}

extern "C-unwind" fn decide_policy(delegate: &AnyObject, _selector: Sel, view: &WKWebView, action: &WKNavigationAction, handler: &DynBlock<dyn Fn(WKNavigationActionPolicy)>) {
    unsafe {
        let main_frame = action.targetFrame().map(|frame| frame.isMainFrame());
        let scheme = action.request().URL().and_then(|url| url.scheme()).map(|scheme| scheme.to_string().to_ascii_lowercase());
        if let Some(policy) = embedded_policy(main_frame, scheme.as_deref()) {
            handler.call((policy,));
            return;
        }
        // Dispatch to the preserved Wry implementation. This keeps app-origin
        // checks, external-opening behavior, and new-window restrictions intact.
        let original = DELEGATE_CLASS.get().expect("Canvas navigation delegate was not registered")
            .superclass().expect("Canvas navigation delegate has no superclass");
        let _: () = msg_send![super(delegate, original), webView: view, decidePolicyForNavigationAction: action, decisionHandler: handler];
    }
}

pub async fn enable(view: &Webview) -> Result<(), String> {
    crate::browser::require_main(view)?;
    let (sender, receiver) = oneshot::channel();
    view.with_webview(move |platform| {
        let result = unsafe {
            let native: &WKWebView = &*platform.inner().cast();
            if let Some(delegate) = native.navigationDelegate() {
                let object: &AnyObject = (&*delegate).as_ref();
                let original = object.class();
                let subclass = DELEGATE_CLASS.get_or_init(|| {
                    let mut builder = ClassBuilder::new(c"CanvagentCanvasNavigationDelegate", original)
                        .expect("Could not register the canvas navigation delegate");
                    builder.add_method(sel!(webView:decidePolicyForNavigationAction:decisionHandler:), decide_policy as extern "C-unwind" fn(_, _, _, _, _));
                    builder.register()
                });
                if original != *subclass && subclass.superclass() != Some(original) {
                    Err("The app navigation delegate changed unexpectedly.".to_string())
                } else {
                    // Change only this instance; Wry's class, ivars, and all
                    // other delegates retain their original implementation.
                    if original != *subclass { AnyObject::set_class(object, subclass); }
                    native.setNavigationDelegate(None);
                    native.setNavigationDelegate(Some(&delegate));
                    Ok(())
                }
            } else {
                Err("The app has no native navigation delegate.".to_string())
            }
        };
        let _ = sender.send(result);
    }).map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(1), receiver).await
        .map_err(|_| "The canvas navigation delegate took too long to respond.".to_string())?
        .map_err(|_| "The canvas navigation delegate is unavailable.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_subframes_bypass_the_main_navigation_policy() {
        for scheme in [Some("http"), Some("https")] {
            assert_eq!(embedded_policy(Some(false), scheme), Some(WKNavigationActionPolicy::Allow));
            assert_eq!(embedded_policy(Some(true), scheme), None);
            assert_eq!(embedded_policy(None, scheme), None);
        }
        for scheme in [None, Some("javascript"), Some("data"), Some("file"), Some("tauri"), Some("about"), Some("blob")] {
            assert_eq!(embedded_policy(Some(false), scheme), Some(WKNavigationActionPolicy::Cancel));
            assert_eq!(embedded_policy(Some(true), scheme), None);
            assert_eq!(embedded_policy(None, scheme), None);
        }
    }
}
