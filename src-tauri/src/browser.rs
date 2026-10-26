use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicU64, Ordering}, RwLock};
use tauri::{webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder}, AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl};
use tokio::sync::{oneshot, Mutex};

const ANNOTATIONS_SCRIPT: &str = include_str!("../../src/shared/browser-annotations.js");

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationCommand { Start, Stop, Settings, Undo, Clear, State }

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationTool { Pen, Highlight, Rectangle }

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationState {
    active: bool,
    tool: AnnotationTool,
    color: String,
    count: usize,
    can_undo: bool,
    document_id: String,
}

fn annotation_request_script(command: AnnotationCommand, tool: Option<AnnotationTool>, color: Option<String>) -> Result<String, String> {
    if let Some(color) = color.as_deref() {
        if color.len() != 7 || !color.starts_with('#') || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit) {
            return Err("Choose a six-digit annotation color.".into());
        }
    }
    let mut request = serde_json::json!({ "command": command });
    if let Some(tool) = tool { request["tool"] = serde_json::json!(tool); }
    if let Some(color) = color { request["color"] = serde_json::json!(color); }
    Ok(format!(r#"(() => {{
        try {{
            {ANNOTATIONS_SCRIPT}
            const api = window.__CANVAGENT_BROWSER_ANNOTATIONS__ ||
                (window.__CANVAGENT_BROWSER_ANNOTATIONS__ = window.__CANVAGENT_CREATE_BROWSER_ANNOTATIONS__(document.body));
            return JSON.stringify(api.command({request}));
        }} catch (_) {{ return JSON.stringify({{"error":true}}); }}
    }})()"#))
}

fn clear_annotations(view: &Webview) {
    let _ = view.eval("window.__CANVAGENT_BROWSER_ANNOTATIONS__?.command({command:'stop'}); window.__CANVAGENT_BROWSER_ANNOTATIONS__?.command({command:'clear'});");
}

fn annotation_response(result: &str) -> Result<AnnotationState, String> {
    let result: serde_json::Value = serde_json::from_str(result).map_err(|_| "The browser annotation response was invalid.".to_string())?;
    // WebKit and WebView2 serialize evaluated string results differently.
    let result = if let Some(value) = result.as_str() { serde_json::from_str(value).map_err(|_| "The browser annotation response was invalid.".to_string())? } else { result };
    serde_json::from_value(result).map_err(|_| "Could not update annotations on this page.".to_string())
}

#[derive(Clone, Copy, Deserialize)]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    url: String,
    title: Option<String>,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    #[serde(default)]
    error: Option<String>,
}

struct BrowserView {
    label: String,
    state: BrowserState,
}

#[derive(Default)]
pub struct BrowserHost {
    operation: Mutex<()>,
    current: RwLock<Option<BrowserView>>,
    next: AtomicU64,
}

// The embedded page is untrusted, including when it visits the app's own origin.
// Capability checks also restrict every command to the main app webview.
pub fn require_main(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" { return Err("Only the Canvagent interface can control the desktop.".into()); }
    Ok(())
}

fn validated_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "Enter a valid http or https address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("The browser supports http and https addresses.".into());
    }
    Ok(url)
}

impl BrowserBounds {
    async fn rect(self, main: &Webview) -> Result<Rect, String> {
        let viewport = main_viewport(main).await?;
        self.in_viewport(viewport)
    }

    fn in_viewport(self, viewport: BrowserViewport) -> Result<Rect, String> {
        if ![self.x, self.y, self.width, self.height].iter().all(|n| n.is_finite()) || self.width < 1.0 || self.height < 1.0 {
            return Err("The browser panel has invalid bounds.".into());
        }
        if ![viewport.x, viewport.y, viewport.width, viewport.height].iter().all(|n| n.is_finite()) || viewport.width < 1.0 || viewport.height < 1.0 {
            return Err("The app viewport is unavailable.".into());
        }
        let x = self.x.max(0.0).min((viewport.width - 1.0).max(0.0));
        let y = self.y.max(0.0).min((viewport.height - 1.0).max(0.0));
        Ok(Rect {
            position: LogicalPosition::new(viewport.x + x, viewport.y + y).into(),
            size: LogicalSize::new(self.width.min(viewport.width - x).max(1.0), self.height.min(viewport.height - y).max(1.0)).into(),
        })
    }
}

#[derive(Clone, Copy)]
struct BrowserViewport {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
async fn main_viewport(main: &Webview) -> Result<BrowserViewport, String> {
    let (sender, receiver) = oneshot::channel();
    main.with_webview(move |platform| unsafe {
        let native: &objc2_web_kit::WKWebView = &*platform.inner().cast();
        let viewport = native.superview().map(|parent| {
            // Tauri's visible titlebar uses a fullsize native content view.
            // WebKit lays out the DOM inside its safe area, while Wry positions
            // child views in their shared parent's coordinates. Convert that
            // actual DOM origin each time so titlebar/fullscreen changes align.
            let safe = parent.convertRect_fromView(native.safeAreaRect(), Some(native));
            BrowserViewport {
                x: safe.origin.x,
                y: if parent.isFlipped() { safe.origin.y } else { parent.frame().size.height - safe.origin.y - safe.size.height },
                width: safe.size.width,
                height: safe.size.height,
            }
        });
        let _ = sender.send(viewport);
    }).map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(1), receiver).await
        .map_err(|_| "The app viewport took too long to respond.".to_string())?
        .map_err(|_| "The app viewport is unavailable.".to_string())?
        .ok_or_else(|| "The app viewport is unavailable.".to_string())
}

#[cfg(not(target_os = "macos"))]
async fn main_viewport(main: &Webview) -> Result<BrowserViewport, String> {
    let scale = main.window().scale_factor().map_err(|e| e.to_string())?;
    let bounds = main.bounds().map_err(|e| e.to_string())?;
    let position = bounds.position.to_logical::<f64>(scale);
    let size = bounds.size.to_logical::<f64>(scale);
    Ok(BrowserViewport { x: position.x, y: position.y, width: size.width, height: size.height })
}

fn current(app: &AppHandle) -> Option<(Webview, BrowserState)> {
    let host = app.state::<BrowserHost>();
    let current = host.current.read().unwrap();
    let current = current.as_ref()?;
    Some((app.get_webview(&current.label)?, current.state.clone()))
}

fn update(app: &AppHandle, label: &str, change: impl FnOnce(&mut BrowserState)) {
    let host = app.state::<BrowserHost>();
    let mut current = host.current.write().unwrap();
    if let Some(view) = current.as_mut().filter(|view| view.label == label) { change(&mut view.state); }
}

async fn snapshot(app: &AppHandle) -> Result<BrowserState, String> {
    let Some((view, fallback)) = current(app) else { return Ok(BrowserState::default()); };
    let requested_url = fallback.url.clone();
    let (sender, receiver) = oneshot::channel();
    #[cfg(target_os = "macos")]
    view.with_webview(move |platform| {
        // Tauri supplies a live WKWebView and runs this closure on the main thread.
        let state = unsafe {
            let native: &objc2_web_kit::WKWebView = &*platform.inner().cast();
            BrowserState {
                url: native.URL().and_then(|url| url.absoluteString()).map(|url| url.to_string()).unwrap_or_default(),
                title: native.title().map(|title| title.to_string()),
                loading: native.isLoading(),
                can_go_back: native.canGoBack(),
                can_go_forward: native.canGoForward(),
                error: None,
            }
        };
        let _ = sender.send(state);
    }).map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    {
        let sender = std::sync::Mutex::new(Some(sender));
        view.eval_with_callback(
            "({url: location.href, title: document.title, loading: document.readyState !== 'complete', canGoBack: window.navigation ? navigation.canGoBack : history.length > 1, canGoForward: window.navigation ? navigation.canGoForward : false})",
            move |value| { if let Some(sender) = sender.lock().unwrap().take() { let _ = sender.send(serde_json::from_str::<BrowserState>(&value).unwrap_or_default()); } },
        ).map_err(|e| e.to_string())?;
    }
    let mut state = tokio::time::timeout(std::time::Duration::from_secs(1), receiver).await.ok().and_then(Result::ok).unwrap_or(fallback);
    // During the first load WKWebView can temporarily report no URL or about:blank.
    if validated_url(&state.url).is_err() { state.url = requested_url; }
    update(app, view.label(), |current| {
        // A failure callback may arrive while native metadata is being read.
        // Keep that failure until the next navigation explicitly clears it.
        state.error = current.error.clone();
        // WKWebView can briefly report isLoading=false before a queued load
        // begins. Completion/failure callbacks own this lifecycle flag.
        state.loading = current.loading;
        if state.error.is_some() { state.loading = false; state.url = current.url.clone(); }
        *current = state.clone();
    });
    Ok(state)
}

#[tauri::command]
pub async fn browser_open(app: AppHandle, webview: Webview, url: String, bounds: BrowserBounds) -> Result<BrowserState, String> {
    require_main(&webview)?;
    let url = validated_url(&url)?;
    let rect = bounds.rect(&webview).await?;
    let host = app.state::<BrowserHost>();
    let _operation = host.operation.lock().await;
    if let Some((view, _)) = current(&app) {
        view.set_bounds(rect).map_err(|e| e.to_string())?;
        view.show().map_err(|e| e.to_string())?;
        update(&app, view.label(), |state| { state.url = url.to_string(); state.loading = true; state.error = None; });
        // Entering an address again must retry even when a previous load failed.
        view.navigate(url).map_err(|e| e.to_string())?;
    } else {
        let label = format!("project-browser-{}", host.next.fetch_add(1, Ordering::Relaxed));
        *host.current.write().unwrap() = Some(BrowserView { label: label.clone(), state: BrowserState { url: url.to_string(), loading: true, ..Default::default() } });
        let popup_app = app.clone();
        let popup_label = label.clone();
        // Attach native failure observation before beginning the requested load.
        let builder = WebviewBuilder::new(&label, WebviewUrl::External("about:blank".parse().unwrap()))
            .initialization_script(ANNOTATIONS_SCRIPT)
            // Wry asks this policy for subframes too. Top-level navigation
            // callbacks own browser state so an iframe cannot leave it loading.
            .on_navigation(|url| matches!(url.scheme(), "http" | "https"))
            .on_document_title_changed(|view, title| update(view.app_handle(), view.label(), |state| state.title = Some(title)))
            .on_page_load(|view, payload| {
                if matches!(payload.event(), PageLoadEvent::Started) { clear_annotations(&view); }
                update(view.app_handle(), view.label(), |state| {
                    state.url = payload.url().to_string();
                    state.loading = matches!(payload.event(), PageLoadEvent::Started);
                });
            })
            .on_new_window(move |url, _| {
                if matches!(url.scheme(), "http" | "https") {
                    let app = popup_app.clone();
                    let label = popup_label.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(view) = app.get_webview(&label) { let _ = view.navigate(url); }
                    });
                }
                NewWindowResponse::Deny
            });
        match webview.window().add_child(builder, rect.position, rect.size) {
            Ok(view) => {
                // A project navigation may clear the session while native creation
                // is queued. Do not leave that old page over the new project.
                let still_current = host.current.read().unwrap().as_ref().is_some_and(|current| current.label == label);
                if !still_current {
                    let _ = view.hide();
                    let _ = view.close();
                    return Ok(BrowserState::default());
                }
                #[cfg(target_os = "macos")]
                if let Err(error) = mac_navigation::observe(&app, &view).await {
                    close_for_navigation(&app);
                    return Err(error);
                }
                view.navigate(url).map_err(|e| e.to_string())?;
            }
            Err(error) => {
                *host.current.write().unwrap() = None;
                return Err(format!("Could not open the browser: {error}"));
            }
        }
    }
    snapshot(&app).await
}

#[tauri::command]
pub async fn browser_bounds(app: AppHandle, webview: Webview, bounds: BrowserBounds) -> Result<(), String> {
    require_main(&webview)?;
    let rect = bounds.rect(&webview).await?;
    if let Some((view, _)) = current(&app) {
        view.set_bounds(rect).map_err(|e| e.to_string())?;
        view.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_hide(app: AppHandle, webview: Webview) -> Result<(), String> {
    require_main(&webview)?;
    if let Some((view, _)) = current(&app) { view.hide().map_err(|e| e.to_string())?; }
    Ok(())
}

pub fn close_for_navigation(app: &AppHandle) {
    let host = app.state::<BrowserHost>();
    let previous = host.current.write().unwrap().take();
    if let Some(previous) = previous {
        #[cfg(target_os = "macos")]
        mac_navigation::forget(&previous.label);
        if let Some(view) = app.get_webview(&previous.label) {
            let _ = view.hide();
            let _ = view.close();
        }
    }
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, webview: Webview) -> Result<(), String> {
    require_main(&webview)?;
    let host = app.state::<BrowserHost>();
    let _operation = host.operation.lock().await;
    close_for_navigation(&app);
    Ok(())
}

#[tauri::command]
pub async fn browser_action(app: AppHandle, webview: Webview, action: String) -> Result<BrowserState, String> {
    require_main(&webview)?;
    let Some((view, previous)) = current(&app) else { return Err("Open a page in the browser first.".into()); };
    update(&app, view.label(), |state| { state.error = None; state.loading = true; });
    match action.as_str() {
        "reload" => {
            if previous.error.is_some() { view.navigate(validated_url(&previous.url)?).map_err(|e| e.to_string())?; }
            else { view.reload().map_err(|e| e.to_string())?; }
        }
        "back" | "forward" => {
            #[cfg(target_os = "macos")]
            view.with_webview(move |platform| unsafe {
                let native: &objc2_web_kit::WKWebView = &*platform.inner().cast();
                if action == "back" { let _ = native.goBack(); } else { let _ = native.goForward(); }
            }).map_err(|e| e.to_string())?;
            #[cfg(not(target_os = "macos"))]
            view.eval(if action == "back" { "history.back()" } else { "history.forward()" }).map_err(|e| e.to_string())?;
        }
        _ => return Err("Unknown browser action.".into()),
    }
    snapshot(&app).await
}

#[tauri::command]
pub async fn browser_state(app: AppHandle, webview: Webview) -> Result<BrowserState, String> {
    require_main(&webview)?;
    snapshot(&app).await
}

#[tauri::command]
pub async fn browser_annotate(app: AppHandle, webview: Webview, command: AnnotationCommand, tool: Option<AnnotationTool>, color: Option<String>) -> Result<AnnotationState, String> {
    require_main(&webview)?;
    let script = annotation_request_script(command, tool, color)?;
    let host = app.state::<BrowserHost>();
    let _operation = host.operation.lock().await;
    let Some((view, _)) = current(&app) else { return Err("Open a page in the browser before annotating.".into()); };
    let (sender, receiver) = oneshot::channel();
    let sender = std::sync::Mutex::new(Some(sender));
    view.eval_with_callback(script, move |result| { if let Some(sender) = sender.lock().unwrap().take() { let _ = sender.send(result); } }).map_err(|e| e.to_string())?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), receiver).await
        .map_err(|_| "The browser annotation surface took too long to respond.".to_string())?
        .map_err(|_| "The browser annotation surface is unavailable.".to_string())?;
    annotation_response(&result)
}

#[cfg(target_os = "macos")]
mod mac_navigation {
    use super::*;
    use objc2::{runtime::{AnyClass, AnyObject, ClassBuilder, Sel}, sel};
    use objc2_foundation::NSError;
    use objc2_web_kit::{WKNavigation, WKWebView};
    use std::{collections::HashMap, sync::{Mutex as StdMutex, OnceLock}};

    #[derive(Clone)]
    struct Observer {
        app: AppHandle,
        label: String,
        navigation: usize,
    }

    static OBSERVERS: OnceLock<StdMutex<HashMap<usize, Observer>>> = OnceLock::new();
    static DELEGATE_CLASS: OnceLock<&'static AnyClass> = OnceLock::new();

    fn observers() -> &'static StdMutex<HashMap<usize, Observer>> { OBSERVERS.get_or_init(Default::default) }

    extern "C-unwind" fn did_start(_delegate: &AnyObject, _selector: Sel, view: &WKWebView, navigation: Option<&WKNavigation>) {
        let observer = {
            let mut observers = observers().lock().unwrap();
            observers.get_mut(&(view as *const _ as usize)).map(|observer| {
                observer.navigation = navigation.map_or(0, |navigation| navigation as *const _ as usize);
                observer.clone()
            })
        };
        if let Some(observer) = observer {
            if let Some(view) = observer.app.get_webview(&observer.label) { clear_annotations(&view); }
            update(&observer.app, &observer.label, |state| { state.error = None; state.loading = true; });
        }
    }

    extern "C-unwind" fn did_fail(_delegate: &AnyObject, _selector: Sel, view: &WKWebView, navigation: Option<&WKNavigation>, error: &NSError) {
        if error.code() == -999 { return; } // Redirects and replaced requests are normal cancellations.
        let observer = observers().lock().unwrap().get(&(view as *const _ as usize)).cloned();
        if let Some(observer) = observer {
            let navigation = navigation.map_or(0, |navigation| navigation as *const _ as usize);
            if observer.navigation != 0 && navigation != 0 && observer.navigation != navigation { return; }
            let message = error_message(&error.domain().to_string(), error.code());
            update(&observer.app, &observer.label, |state| { state.error = Some(message); state.loading = false; });
        }
    }

    pub(super) fn error_message(domain: &str, code: isize) -> String {
        // NSError descriptions can contain complete URLs. Keep user-facing
        // messages useful without copying queries, credentials, or page data.
        if domain == "NSURLErrorDomain" {
            match code {
                -1001 => "The page took too long to respond. Try reloading it.",
                -1003 => "The server could not be found. Check the address.",
                -1004 => "Could not connect to the server. Check that it is running and the port is correct.",
                -1005 => "The connection was interrupted. Try reloading the page.",
                -1009 => "The network connection is unavailable.",
                -1022 => "macOS blocked this HTTP page under its transport-security policy.",
                -1206..=-1200 => "A secure connection could not be established. Check the server's TLS certificate.",
                _ => return format!("The page could not be loaded (network error {code})."),
            }.to_string()
        } else {
            format!("The page could not be loaded (WebKit error {code}).")
        }
    }

    pub async fn observe(app: &AppHandle, view: &Webview) -> Result<(), String> {
        let app = app.clone();
        let label = view.label().to_string();
        let (sender, receiver) = oneshot::channel();
        view.with_webview(move |platform| {
            let result = unsafe {
                let native: &WKWebView = &*platform.inner().cast();
                if let Some(delegate) = native.navigationDelegate() {
                    let object: &AnyObject = (&*delegate).as_ref();
                    let original = object.class();
                    let subclass = DELEGATE_CLASS.get_or_init(|| {
                        let mut builder = ClassBuilder::new(c"CanvagentBrowserNavigationDelegate", original)
                            .expect("Could not register the browser navigation observer");
                        builder.add_method(sel!(webView:didStartProvisionalNavigation:), did_start as extern "C-unwind" fn(_, _, _, _));
                        builder.add_method(sel!(webView:didFailProvisionalNavigation:withError:), did_fail as extern "C-unwind" fn(_, _, _, _, _));
                        builder.add_method(sel!(webView:didFailNavigation:withError:), did_fail as extern "C-unwind" fn(_, _, _, _, _));
                        builder.register()
                    });
                    // This per-instance subclass adds no ivars and preserves
                    // Wry's inherited navigation policies and completion hooks.
                    // No method on Wry's original delegate class is changed.
                    if original != *subclass && subclass.superclass() != Some(original) {
                        Err("The native browser navigation delegate changed unexpectedly.".to_string())
                    } else {
                        if original != *subclass { AnyObject::set_class(object, subclass); }
                        observers().lock().unwrap().insert(native as *const _ as usize, Observer { app, label, navigation: 0 });
                        // WebKit caches optional delegate selectors when assigned.
                        native.setNavigationDelegate(None);
                        native.setNavigationDelegate(Some(&delegate));
                        Ok(())
                    }
                } else {
                    Err("The native browser has no navigation delegate.".to_string())
                }
            };
            let _ = sender.send(result);
        }).map_err(|e| e.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(1), receiver).await
            .map_err(|_| "The browser navigation observer took too long to respond.".to_string())?
            .map_err(|_| "The browser navigation observer is unavailable.".to_string())?
    }

    pub fn forget(label: &str) { observers().lock().unwrap().retain(|_, observer| observer.label != label); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_coordinates_follow_the_native_viewport() {
        let bounds = BrowserBounds { x: 450.0, y: 150.0, width: 550.0, height: 500.0 };
        for top in [0.0, 28.0, 37.0] {
            let rect = bounds.in_viewport(BrowserViewport { x: 0.0, y: top, width: 1200.0, height: 800.0 }).unwrap();
            let position = rect.position.to_logical::<f64>(2.0);
            assert_eq!((position.x, position.y), (450.0, 150.0 + top));
        }
    }

    #[test]
    fn browser_bounds_clip_to_the_dom_viewport() {
        let rect = BrowserBounds { x: -10.0, y: 600.0, width: 2000.0, height: 400.0 }
            .in_viewport(BrowserViewport { x: 8.0, y: 24.0, width: 1000.0, height: 750.0 }).unwrap();
        let position = rect.position.to_logical::<f64>(1.0);
        let size = rect.size.to_logical::<f64>(1.0);
        assert_eq!((position.x, position.y), (8.0, 624.0));
        assert_eq!((size.width, size.height), (1000.0, 150.0));
        assert!(BrowserBounds { x: f64::NAN, y: 0.0, width: 100.0, height: 100.0 }
            .in_viewport(BrowserViewport { x: 0.0, y: 0.0, width: 1000.0, height: 750.0 }).is_err());
    }

    #[test]
    fn annotation_commands_validate_settings_before_page_evaluation() {
        for color in ["red", "#123", "#ff0000; alert(1)", "#gg0000", "#1234567"] {
            assert!(annotation_request_script(AnnotationCommand::Start, Some(AnnotationTool::Pen), Some(color.into())).is_err());
        }
        let script = annotation_request_script(AnnotationCommand::Settings, Some(AnnotationTool::Rectangle), Some("#Aa0099".into())).unwrap();
        assert!(script.contains(r#""command":"settings""#));
        assert!(script.contains(r#""tool":"rectangle""#));
        assert!(script.contains(r##""color":"#Aa0099""##));
        assert!(serde_json::from_str::<AnnotationCommand>(r#""execute""#).is_err());
    }

    #[test]
    fn annotation_state_decodes_native_callback_formats() {
        let state = r##"{"active":true,"tool":"highlight","color":"#e5484d","count":2,"canUndo":true,"documentId":"document-1"}"##;
        for payload in [state.to_string(), serde_json::to_string(state).unwrap()] {
            let result = annotation_response(&payload).unwrap();
            assert!(result.active && result.can_undo);
            assert_eq!(result.count, 2);
            assert_eq!(result.document_id, "document-1");
        }
        assert!(annotation_response(r#"{"error":true}"#).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn browser_reports_network_failures_without_sensitive_urls() {
        assert!(mac_navigation::error_message("NSURLErrorDomain", -1004).contains("server"));
        assert!(mac_navigation::error_message("NSURLErrorDomain", -1022).contains("macOS blocked"));
        assert!(mac_navigation::error_message("NSURLErrorDomain", -1202).contains("TLS certificate"));
        assert_eq!(mac_navigation::error_message("https://private.example/?token=secret", 7), "The page could not be loaded (WebKit error 7).");
    }
}
