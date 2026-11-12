export const analyticsStyles = String.raw`
#plausible-app {
  color-scheme: light dark;
  --ink: var(--color-text-primary, light-dark(#202020,#f2f2f2));
  --sub: var(--color-text-secondary, light-dark(#595959,#b5b5b5));
  --line: var(--color-border-tertiary, light-dark(#d9d9d9,#424242));
  --paper: var(--color-background-primary, light-dark(#ffffff,#191919));
  --soft: var(--color-background-secondary, light-dark(#f3f3f3,#292929));
  --accent: var(--color-text-info, light-dark(#4a54c8,#a6acff));
  box-sizing:border-box; overflow:auto; max-width:100%; background:transparent; color:var(--ink);
  --pad:var(--plausible-content-inset,clamp(14px,2.5vw,22px));
  padding:max(var(--pad),var(--safe-top,0px)) max(var(--pad),var(--safe-right,0px)) max(var(--pad),var(--safe-bottom,0px)) max(var(--pad),var(--safe-left,0px));
  font:var(--font-text-md-size,14px)/1.45 var(--font-sans,system-ui,sans-serif); font-variant-numeric:tabular-nums;
}
#plausible-app * {box-sizing:border-box}
#plausible-app [hidden] {display:none!important}
#plausible-app :is(h2,p) {margin:0}
#plausible-app .identity {display:flex;gap:8px;align-items:center;color:var(--sub);font-weight:600;font-size:var(--font-text-xs-size,12px)}
#plausible-app .mark {display:inline-flex;gap:2px;align-items:flex-end;height:15px}
#plausible-app .mark i {width:4px;background:var(--accent);border-radius:2px}
#plausible-app .mark i:nth-child(1){height:7px} #plausible-app .mark i:nth-child(2){height:11px} #plausible-app .mark i:nth-child(3){height:15px}
#plausible-app .heading,#plausible-app .controls,#plausible-app .pager {display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
#plausible-app .heading {margin:6px 0 12px}
#plausible-app h2 {font-size:var(--font-heading-md-size,clamp(20px,3vw,25px));letter-spacing:-.025em;line-height:1.15}
#plausible-app .context,#plausible-app .detail {color:var(--sub);overflow-wrap:anywhere}
#plausible-app .context {font-size:var(--font-text-sm-size,13px);margin-top:5px}
#plausible-app .controls {padding:0 0 12px}
#plausible-app .result {display:flow-root}
#plausible-app :is(select,button) {font:inherit;color:var(--ink);font-size:var(--font-text-sm-size,13px);border:1px solid var(--line);border-radius:var(--border-radius-sm,6px);background:var(--paper);padding:5px 9px;cursor:pointer}
#plausible-app .metric-picker {position:relative;display:inline-grid;max-width:100%}
#plausible-app .metric-picker select {appearance:none;width:100%;padding-inline:10px 32px}
#plausible-app .metric-picker::after {content:"";position:absolute;inset-inline-end:12px;top:50%;width:6px;height:6px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:translateY(-70%) rotate(45deg);pointer-events:none}
@media(forced-colors:active){#plausible-app .metric-picker select {appearance:auto;padding-inline-end:8px} #plausible-app .metric-picker::after {display:none}}
@media(pointer:coarse){#plausible-app :is(select,button) {min-height:44px} #plausible-app .metric-picker select {font-size:16px}}
#plausible-app button:enabled:hover {background:var(--soft)}
#plausible-app button:disabled {opacity:.45;cursor:default}
#plausible-app :focus-visible {outline:2px solid var(--color-ring-primary,var(--accent));outline-offset:2px}
#plausible-app .modes {display:flex;gap:2px;padding:2px;background:var(--soft);border-radius:7px}
#plausible-app .modes button {border:0;background:transparent;color:var(--sub)}
#plausible-app .modes button[aria-pressed=true] {background:var(--paper);color:var(--ink);box-shadow:0 1px 3px #0002}
#plausible-app .value {font-size:clamp(26px,5vw,38px);font-weight:650;letter-spacing:-.055em;line-height:1.25}
#plausible-app .detail {font-size:var(--font-text-xs-size,12px)}
#plausible-app .plot {display:block;width:100%;height:176px;touch-action:pan-y;color:var(--sub);overflow:visible}
#plausible-app .plot text {font:11px var(--font-sans,system-ui,sans-serif);fill:currentColor}
#plausible-app .ranking {display:grid;grid-template-columns:minmax(0,1fr) max-content;gap:3px 12px;margin:0;padding:0;list-style:none}
#plausible-app .rank {display:grid;grid-column:1/-1;grid-template-columns:subgrid;align-items:center;min-height:30px}
#plausible-app .rank strong {text-align:end;font-weight:550}
#plausible-app .rank-label {position:relative;isolation:isolate;overflow-wrap:anywhere;padding:5px 9px}
#plausible-app .rank-label::before {content:"";position:absolute;z-index:-1;inset-block:0;inset-inline-start:0;width:var(--share);border-radius:3px;background:color-mix(in srgb,var(--accent) 17%,transparent)}
#plausible-app .table-wrap {overflow-x:auto}
#plausible-app table {border-collapse:collapse;width:100%} #plausible-app :is(th,td) {padding:8px 9px;text-align:right;border-bottom:1px solid var(--line);font-size:var(--font-text-sm-size,13px);white-space:nowrap}
#plausible-app th {font-weight:550;color:var(--sub)}
#plausible-app :is(th,td):first-child {text-align:left;white-space:normal;overflow-wrap:anywhere}
#plausible-app .pair {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:12px 0}
#plausible-app .pair>div {border-left:2px solid var(--line);padding-left:10px;overflow-wrap:anywhere}
#plausible-app .pair>div:last-child {border-color:var(--accent)}
#plausible-app .pager {margin:10px 0} #plausible-app .pager div {display:flex;gap:5px}
#plausible-app .note {margin-top:12px;color:var(--sub);font-size:var(--font-text-sm-size,13px)}
#plausible-app .state-message {padding-block:12px;color:var(--sub)}
#plausible-app code {overflow-wrap:anywhere}
#plausible-app .day-action {display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;min-height:36px}
#plausible-app .day-action textarea {width:100%;box-sizing:border-box;min-height:4em;font:inherit;color:var(--ink);background:var(--paper);border:1px solid var(--line)}
#plausible-app .trend-legend {display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--sub);font-size:var(--font-text-xs-size,12px)}
#plausible-app .trend-swatch::before {content:"";display:inline-block;width:15px;margin-inline-end:6px;vertical-align:middle;border-top:2px solid var(--accent)}
#plausible-app .trend-swatch.dashed::before {border-top:2px dashed var(--sub)}
#plausible-app .trend-plot {position:relative;isolation:isolate;container-type:inline-size;margin-block-start:8px}
#plausible-app .trend-plot .plot {height:192px;cursor:crosshair}
#plausible-app .trend-tooltip {position:absolute;width:max-content;max-width:calc(100% - 8px);display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:baseline;gap:4px 8px;padding:9px 12px;border:1px solid var(--line);border-radius:var(--border-radius-sm,6px);background:var(--paper);color:var(--ink);box-shadow:0 3px 12px #0002;font-size:var(--font-text-sm-size,13px);line-height:1.35}
#plausible-app .tip-title {grid-column:1/-1;font-weight:600;margin-bottom:2px}
#plausible-app .tip-date {color:var(--sub)}
#plausible-app .tip-number {text-align:end;font-weight:600;overflow-wrap:anywhere}
#plausible-app .tip-change {grid-column:1/-1;display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--line);padding-top:5px;margin-top:2px}
@container (width < 380px){#plausible-app .trend-plot .plot {height:252px} #plausible-app .tip-series {display:none} #plausible-app .trend-tooltip .trend-swatch::before {margin-inline-end:0}}
#plausible-app .trend-plot:has(.trend-tooltip[hidden]) .trend-guide {display:none}
`;
