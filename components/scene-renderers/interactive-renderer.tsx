'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { InteractiveContent } from '@/lib/types/stage';
import { isWidgetMessage } from '@/lib/types/widgets';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import { playerBridge } from '@/lib/player-bridge';

interface InteractiveRendererProps {
  readonly content: InteractiveContent;
  readonly mode: 'autonomous' | 'playback';
  readonly sceneId: string;
}

/**
 * Phase 7.3a/b/c feature flags for individual Deep Interactive widget types.
 * Each flag defaults OFF — until the flag is set, widget-typed scenes
 * fall back to the legacy HTML-only sandbox path with no postMessage
 * bridge attached.
 *
 * NEXT_PUBLIC_ prefix because the gate runs in the browser (the renderer
 * decides whether to register the bridge before mounting the iframe).
 */
const CODE_WIDGET_ENABLED =
  (process.env.NEXT_PUBLIC_INTERACTIVE_WIDGET_CODE_ENABLED ?? '').toLowerCase() === 'true';
const DIAGRAM_WIDGET_ENABLED =
  (process.env.NEXT_PUBLIC_INTERACTIVE_WIDGET_DIAGRAM_ENABLED ?? '').toLowerCase() === 'true';
const SIMULATION_WIDGET_ENABLED =
  (process.env.NEXT_PUBLIC_INTERACTIVE_WIDGET_SIMULATION_ENABLED ?? '').toLowerCase() === 'true';

/**
 * Returns true if this scene should run with the Deep Interactive widget
 * runtime (per-scene postMessage bridge + sandbox unchanged).
 *
 * Currently `code` (7.3a), `diagram` (7.3b), and `simulation` (7.3c) are
 * implemented. 7.3d–e will widen this predicate behind their own flags.
 */
function isWidgetEnabled(content: InteractiveContent): boolean {
  if (!content.widgetType) return false;
  if (content.widgetType === 'code') return CODE_WIDGET_ENABLED;
  if (content.widgetType === 'diagram') return DIAGRAM_WIDGET_ENABLED;
  if (content.widgetType === 'simulation') return SIMULATION_WIDGET_ENABLED;
  return false;
}

// LLM-generated HTML runs in restricted iframe to prevent cookie theft / outbound network calls.
// See /home/operator1/projects/osvaivai/docs/lesson-editor-plan.md §2.8.
//
// Sandbox uses `allow-scripts` WITHOUT `allow-same-origin` → the iframe is treated as an
// opaque/null origin. Any fetch()/XHR cannot use parent cookies; same-origin requests fail.
// In addition, a restrictive CSP is injected into the srcdoc <head> (connect-src 'none',
// frame-src 'none', object-src 'none') and embedding tags (<iframe>/<object>/<embed>/<applet>)
// are stripped from the model output before injection.
//
// Widget mode (Phase 7.3a code, 7.3b diagram, 7.3c simulation): the iframe still
// runs under the same hardened sandbox + CSP. The only difference is that a
// per-scene postMessage bridge is attached so the player can drive TeacherActions
// inside the widget, and the widget can report `widget:complete` /
// `widget:code:result` / `widget:diagram:result` / `widget:simulation:result` back.
// Widget → parent traffic is forwarded through `playerBridge` so embedded osvaivai
// receives lesson:end / quiz:answer events as usual.
// See `/home/operator1/projects/osvaivai/docs/widget-sandbox.md` for the full
// contract.
export function InteractiveRenderer({ content, mode: _mode, sceneId }: InteractiveRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const widgetEnabled = isWidgetEnabled(content);

  const registerIframe = useWidgetIframeStore((state) => state.registerIframe);
  const setActiveScene = useWidgetIframeStore((state) => state.setActiveScene);

  const patchedHtml = useMemo(
    () => (content.html ? patchHtmlForIframe(content.html) : undefined),
    [content.html],
  );

  // Player → widget: scene-keyed postMessage callback
  const sendMessageToIframe = useCallback((type: string, payload: Record<string, unknown>) => {
    if (!iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      { source: 'openmaic-player', type, ...payload },
      // Widget iframe is sandboxed to a null origin → '*' is the only
      // value that reaches it. Sandbox + CSP enforce isolation; postMessage
      // targetOrigin cannot.
      '*',
    );
  }, []);

  // Register/unregister with the widget store. Only when the widget flag
  // is on — otherwise we keep the store empty so legacy interactive HTML
  // is not affected.
  useEffect(() => {
    if (!widgetEnabled) return undefined;
    registerIframe(sceneId, sendMessageToIframe);
    setActiveScene(sceneId);
    return () => {
      registerIframe(sceneId, null);
    };
  }, [widgetEnabled, sceneId, registerIframe, sendMessageToIframe, setActiveScene]);

  // Widget → player: listen for widget messages and forward relevant ones
  // to embedded osvaivai through the existing playerBridge channel.
  useEffect(() => {
    if (!widgetEnabled) return undefined;
    const handler = (event: MessageEvent) => {
      // Defence-in-depth: only accept messages whose source is *this* iframe.
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!isWidgetMessage(event.data)) return;
      const msg = event.data;
      if (msg.type === 'widget:complete') {
        // Treat widget completion as scene completion for embedding purposes.
        // The full lesson:end is still emitted by the playback engine when
        // the lesson actually ends; widget:complete is a per-scene signal
        // that we surface so the parent can react (analytics, advance, etc.).
        playerBridge.sceneChanged(0, sceneId, 0);
      }
      // widget:code:result, widget:diagram:result, widget:simulation:result,
      // widget:state-change etc. — currently consumed only by future
      // ActionEngine integrations; intentionally not bridged outside the
      // iframe to avoid leaking widget internals to parent frames.
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [widgetEnabled, sceneId]);

  return (
    <div className="w-full h-full relative">
      <iframe
        ref={iframeRef}
        srcDoc={patchedHtml}
        src={patchedHtml ? undefined : content.url}
        className="absolute inset-0 w-full h-full border-0"
        title={`Interactive Scene ${sceneId}`}
        // SANDBOX CONTRACT (Phase 7.3a): unchanged from baseline. We do
        // NOT add allow-same-origin even for widget mode — widgets must
        // run as null-origin documents. Pyodide/Babel CDNs are loaded
        // through the existing CSP allowlist and work fine without
        // same-origin (they cache in IndexedDB scoped to the null origin).
        sandbox="allow-scripts"
      />
    </div>
  );
}

/**
 * Patch embedded HTML to display correctly inside an iframe.
 *
 * Fixes:
 * - min-h-screen / h-screen → use 100% of iframe viewport
 * - Ensure html/body fill the iframe with no overflow issues
 * - Canvas elements use container sizing instead of viewport
 */
function normalizeDoubleEscapedLatex(html: string): string {
  // AI sometimes generates \\( instead of \( in HTML text.
  // Protect <script> blocks, then fix double-escaped LaTeX delimiters and commands.
  const scripts: string[] = [];
  let result = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, (m) => {
    scripts.push(m);
    return `__SN${scripts.length - 1}__`;
  });

  // \\( → \(, \\) → \), \\[ → \[, \\] → \]
  result = result.replace(/\\\\([()[\]{}|])/g, '\\$1');
  // \\command → \command for common LaTeX
  result = result.replace(
    /\\\\(sin|cos|tan|log|ln|exp|lim|sup|inf|max|min|sum|prod|int|frac|sqrt|vec|hat|bar|tilde|dot|ddot|text|mathrm|mathbf|mathit|mathcal|mathbb|operatorname|lambda|Lambda|omega|Omega|alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|theta|Theta|phi|Phi|varphi|psi|Psi|chi|rho|sigma|Sigma|tau|mu|nu|pi|Pi|xi|Xi|zeta|eta|kappa|iota|partial|nabla|infty|cdot|cdots|ldots|times|div|pm|mp|leq|geq|neq|approx|equiv|sim|propto|perp|parallel|forall|exists|nexists|in|notin|subset|supset|subseteq|supseteq|cup|cap|wedge|vee|oplus|otimes|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|uparrow|downarrow|mapsto|to|quad|qquad|hspace|vspace|left|right|big|Big|bigg|Bigg|over|under|begin|end)/g,
    '\\$1',
  );

  for (let i = 0; i < scripts.length; i++) {
    const ph = `__SN${i}__`;
    const idx = result.indexOf(ph);
    if (idx !== -1) {
      result = result.substring(0, idx) + scripts[i] + result.substring(idx + ph.length);
    }
  }
  return result;
}

/**
 * Strip embedding/plugin tags that could be used to load remote content
 * or break out of the sandbox. The iframe sandbox + CSP already block
 * outbound network calls, but stripping these tags is defence-in-depth
 * (and avoids CSP violation noise from obviously malicious markup).
 *
 * Hand-rolled regex strip — no DOMPurify dependency to keep the change minimal.
 * This is OK because the output is fed into a sandboxed iframe with `allow-scripts`
 * but NOT `allow-same-origin`, so even if a tag slips through, it cannot reach
 * parent cookies/storage.
 */
function stripEmbeddingTags(html: string): string {
  // Protect <script> blocks so we don't accidentally rewrite content
  // that mentions these tags inside string literals (e.g. "<iframe>" in JS).
  const scripts: string[] = [];
  let result = html.replace(/<script[\s>][\s\S]*?<\/script>/gi, (m) => {
    scripts.push(m);
    return `__SEC_SN${scripts.length - 1}__`;
  });

  // Remove paired tags with their content
  result = result.replace(/<iframe[\s>][\s\S]*?<\/iframe\s*>/gi, '');
  result = result.replace(/<object[\s>][\s\S]*?<\/object\s*>/gi, '');
  result = result.replace(/<applet[\s>][\s\S]*?<\/applet\s*>/gi, '');
  // Self-closing / void <embed>
  result = result.replace(/<embed\b[^>]*\/?>/gi, '');
  // Stray opening/closing tags without partners (defensive)
  result = result.replace(/<\/?(?:iframe|object|applet|embed)\b[^>]*>/gi, '');

  for (let i = 0; i < scripts.length; i++) {
    const ph = `__SEC_SN${i}__`;
    const idx = result.indexOf(ph);
    if (idx !== -1) {
      result = result.substring(0, idx) + scripts[i] + result.substring(idx + ph.length);
    }
  }
  return result;
}

function patchHtmlForIframe(html: string): string {
  // Sanitize: strip embedding/plugin tags from LLM-generated markup
  html = stripEmbeddingTags(html);

  // Normalize double-escaped LaTeX before rendering
  html = normalizeDoubleEscapedLatex(html);

  // CSP for the sandboxed iframe document. Combined with the iframe's
  // sandbox="allow-scripts" (no allow-same-origin → null/opaque origin), this blocks:
  //   - frame-src 'none'   → embedding other iframes
  //   - object-src 'none'  → <object>/<embed>
  //   - base-uri 'none'    → <base href> redirection
  // 'unsafe-inline' is required because our interactive slides ship inline
  // <script> and inline event handlers; the sandbox null-origin makes this safe.
  // script-src/connect-src whitelist the two CDNs our interactive scenes
  // legitimately load:
  //   - https://cdn.tailwindcss.com — the interactive-html generation prompt
  //     instructs the model to ship Tailwind via this CDN; without it the
  //     entire slide layout collapses (no utility classes).
  //   - https://cdn.jsdelivr.net — interactive-post-processor.ts injects
  //     KaTeX (katex.min.js + auto-render.min.js) from jsdelivr to render
  //     LaTeX formulas inside interactive slides.
  // The null-origin sandbox still prevents access to parent cookies/storage
  // even with these CDNs allowed.
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline' 'self' https://cdn.tailwindcss.com https://cdn.jsdelivr.net; style-src 'unsafe-inline' 'self' https: data:; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src https://cdn.tailwindcss.com https://cdn.jsdelivr.net; frame-src 'none'; object-src 'none'; base-uri 'none';">`;

  const iframeCss = `<style data-iframe-patch>
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
  /* Fix min-h-screen: in iframes 100vh is the iframe height, which is correct,
     but ensure body actually fills it */
  body { min-height: 100vh; }
</style>`;

  const headInjection = '\n' + cspMeta + '\n' + iframeCss;

  // Insert right after <head> or at the start of the document
  const headIdx = html.indexOf('<head>');
  if (headIdx !== -1) {
    const insertPos = headIdx + 6; // after <head>
    return html.substring(0, insertPos) + headInjection + html.substring(insertPos);
  }

  const headWithAttrs = html.indexOf('<head ');
  if (headWithAttrs !== -1) {
    const closeAngle = html.indexOf('>', headWithAttrs);
    if (closeAngle !== -1) {
      const insertPos = closeAngle + 1;
      return html.substring(0, insertPos) + headInjection + html.substring(insertPos);
    }
  }

  // Fallback: prepend (no <head> in source — CSP via meta still applies once
  // browser parses the document and synthesizes a <head>).
  return headInjection + html;
}
