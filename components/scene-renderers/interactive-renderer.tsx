'use client';

import { useMemo } from 'react';
import type { InteractiveContent } from '@/lib/types/stage';

interface InteractiveRendererProps {
  readonly content: InteractiveContent;
  readonly mode: 'autonomous' | 'playback';
  readonly sceneId: string;
}

// LLM-generated HTML runs in restricted iframe to prevent cookie theft / outbound network calls.
// See /home/operator1/projects/osvaivai/docs/lesson-editor-plan.md §2.8.
//
// Sandbox uses `allow-scripts` WITHOUT `allow-same-origin` → the iframe is treated as an
// opaque/null origin. Any fetch()/XHR cannot use parent cookies; same-origin requests fail.
// In addition, a restrictive CSP is injected into the srcdoc <head> (connect-src 'none',
// frame-src 'none', object-src 'none') and embedding tags (<iframe>/<object>/<embed>/<applet>)
// are stripped from the model output before injection.
export function InteractiveRenderer({ content, mode: _mode, sceneId }: InteractiveRendererProps) {
  const patchedHtml = useMemo(
    () => (content.html ? patchHtmlForIframe(content.html) : undefined),
    [content.html],
  );

  return (
    <div className="w-full h-full relative">
      <iframe
        srcDoc={patchedHtml}
        src={patchedHtml ? undefined : content.url}
        className="absolute inset-0 w-full h-full border-0"
        title={`Interactive Scene ${sceneId}`}
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
  // sandbox="allow-scripts" (no allow-same-origin), this blocks:
  //   - connect-src 'none' → fetch / XHR / WebSocket / EventSource
  //   - frame-src 'none'   → embedding other iframes
  //   - object-src 'none'  → <object>/<embed>
  // 'unsafe-inline' is required because our interactive slides ship inline
  // <script> and inline event handlers; the sandbox null-origin makes this safe.
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self' https: data:; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none';">`;

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
