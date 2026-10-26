// An isolated WebKit compatibility probe. It never shows a window, activates
// an app, captures a screen, or loads any page other than its loopback fixture.
import AppKit
import Foundation
import WebKit

final class NavigationProbe: NSObject, WKNavigationDelegate {
    var result: [String: Any]?
    var annotationsSource: String?
    private var checkingAnnotations = false

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let annotationsSource = annotationsSource else {
            result = ["status": "loaded"]
            return
        }
        if checkingAnnotations { return }
        checkingAnnotations = true
        // Only our own overlay canvas is inspected, never page pixels or text.
        // Return boolean compatibility checks, not rendered data or page data.
        let checks = #"""
        (() => {
            const bridgeAbsent = !window.__TAURI_INTERNALS__ && !window.__TAURI__;
            const factoryOnly = !document.querySelector('[data-canvagent-browser-annotations]');
            const api = window.__CANVAGENT_CREATE_BROWSER_ANNOTATIONS__(document.body);
            const host = document.querySelector('[data-canvagent-browser-annotations]');
            const canvas = host.shadowRoot.querySelector('canvas');
            const context = canvas.getContext('2d');
            const alphaAt = (x, y) => context.getImageData(Math.round(x * canvas.width / innerWidth), Math.round(y * canvas.height / innerHeight), 1, 1).data[3];
            const ink = () => {
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                let count = 0;
                for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count++;
                return count;
            };
            const pointer = (name, x, y) => canvas.dispatchEvent(new PointerEvent(name, {
                bubbles: true, composed: true, pointerId: 1, pointerType: 'mouse',
                isPrimary: true, button: 0, buttons: name === 'pointerup' ? 0 : 1,
                clientX: x, clientY: y,
            }));
            const draw = (x, y, endX, endY) => {
                pointer('pointerdown', x, y);
                pointer('pointermove', endX, endY);
                pointer('pointerup', endX, endY);
            };
            const started = api.command({command: 'start', tool: 'pen', color: '#3F7FE0'});
            draw(30, 40, 150, 110);
            const pen = api.command({command: 'state'});
            const penDraws = started.active && started.tool === 'pen' && started.color === '#3f7fe0' && pen.count === 1 && pen.canUndo && ink() > 0;
            api.command({command: 'settings', tool: 'highlight', color: '#E9AD28'});
            draw(60, 200, 180, 200);
            const highlight = api.command({command: 'state'});
            const translucent = alphaAt(120, 200);
            const highlightDraws = highlight.count === 2 && highlight.tool === 'highlight' && highlight.color === '#e9ad28' && translucent > 0 && translucent < 255;
            api.command({command: 'settings', tool: 'rectangle', color: '#38A16C'});
            draw(250, 50, 350, 150);
            const rectangleDraws = api.command({command: 'state'}).count === 3 && alphaAt(300, 50) > 0;
            const undone = api.command({command: 'undo'});
            const undoWorks = undone.count === 2 && undone.active && alphaAt(300, 50) === 0 && ink() > 0;
            const stopped = api.command({command: 'stop'});
            draw(400, 300, 500, 350);
            const stopWorks = !stopped.active && stopped.count === 2 && canvas.style.pointerEvents === 'none' && api.command({command: 'state'}).count === 2 && ink() > 0;
            const cleared = api.command({command: 'clear'});
            const clearWorks = cleared.count === 0 && !cleared.canUndo && ink() === 0;
            api.command({command: 'start'});
            draw(30, 40, 150, 110);
            history.pushState({}, '', '?annotation-navigation');
            const navigated = api.command({command: 'state'});
            const navigationClears = !navigated.active && navigated.count === 0 && ink() === 0;
            api.dispose();
            const disposeWorks = !document.querySelector('[data-canvagent-browser-annotations]');
            return {bridgeAbsent, factoryOnly, penDraws, highlightDraws, rectangleDraws, undoWorks, stopWorks, clearWorks, navigationClears, disposeWorks};
        })()
        """#
        webView.evaluateJavaScript(annotationsSource + "\n" + checks) { value, error in
            if let error = error as NSError? {
                self.result = ["status": "annotation-error", "domain": error.domain, "code": error.code]
            } else if let checks = value as? [String: Any] {
                // macOS may allocate a hidden TUINSWindow text-input helper.
                // Verify no window is shown or takes focus, independent of it.
                let windows = NSApplication.shared.windows
                self.result = ["status": "annotated", "checks": checks,
                    "visibleWindowCount": windows.filter { $0.isVisible }.count,
                    "keyWindowCount": windows.filter { $0.isKeyWindow }.count,
                    "mainWindowCount": windows.filter { $0.isMainWindow }.count,
                    "activationProhibited": NSApplication.shared.activationPolicy() == .prohibited]
            } else {
                self.result = ["status": "annotation-invalid"]
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    private func fail(_ error: Error) {
        let error = error as NSError
        if error.code == NSURLErrorCancelled { return }
        // Report only the system category and code, never page data or URLs.
        result = ["status": "failed", "domain": error.domain, "code": error.code]
    }
}

guard [2, 3].contains(CommandLine.arguments.count),
      let url = URL(string: CommandLine.arguments[1]),
      ["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host ?? ""),
      ["http", "https"].contains(url.scheme ?? "") else {
    fputs("Supply one loopback HTTP(S) address and an optional annotation script path.\n", stderr)
    exit(2)
}

NSApplication.shared.setActivationPolicy(.prohibited)
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
let probe = NavigationProbe()
if CommandLine.arguments.count == 3 {
    probe.annotationsSource = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
}
webView.navigationDelegate = probe
webView.load(URLRequest(url: url))
let deadline = Date(timeIntervalSinceNow: 12)
while probe.result == nil && Date() < deadline {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
}
let result = probe.result ?? ["status": "timeout"]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
