import{f as st,a as rt}from"./reactSourceValidation-DRA7e8Q6.js";import"./index-BehqdrzV.js";const E=/\.(jsx?|tsx?)$/i,at=new Set(["App","Button","Card","Dialog","Drawer","Form","Image","Input","Label","Layout","Link","Menu","Modal","Option","Select","Sheet","Tab","Tabs","Textarea"]),T=/import\s*{\s*([^}]+)\s*}\s*from\s*(["'])lucide-react\2;?/m,ot=/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?/g,P=/((?:import\s+[^"'`]*?\s+from\s+|export\s+[^"'`]*?\s+from\s+|import\s+|import\s*\(\s*|require\s*\(\s*))(["'])([^"']+)\2/g,it=/(?:export\s+default\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(/g,ct=/(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=/g,pt=/class\s+([A-Z][A-Za-z0-9_]*)\s+/g,lt=/<([A-Z][A-Za-z0-9_]*)\b([^>]*)\/?>/g,dt=/\b(dataKey|stroke|fill|stackId|dot|activeDot|type|connectNulls|xAxisId|yAxisId|name|unit|baseValue|points|layout)\s*=/,ut="\\bexport\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+%s\\b",w=/\b(?:React\.)?Children\.only\(\s*(children|props\.children)\s*\)/g,_="__auraEnsureRenderableChild",ht=/\b(path|to|href)\s*=\s*(["'])([^"']+)\2/g,ft=/\b(path|to|href)\s*:\s*(["'])([^"']+)\2/g,mt=/\b(navigate|redirect|replace|push)\s*\(\s*(["'])([^"']+)\2/g,gt=/\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+(["'])react-dom\/client\2;?/g,$t=/(?:^|\/)src\/(?:main|index)\.(?:jsx?|tsx?)$/i,O=/((?:export\s+default\s+)?function\s+[A-Z][A-Za-z0-9_$]*\s*\([^)]*\)\s*{)/,z=/((?:export\s+default\s+)?const\s+[A-Z][A-Za-z0-9_$]*\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*{)/,N=/\bexport\s+default\s+function\s+([A-Z][A-Za-z0-9_$]*)\s*\(/,xt=/\bvalue\s*=\s*{\s*([a-z][A-Za-z0-9_$]*)\s*}/g,Et=/\btoast\b/,Rt=`/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};
`,_t=`export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;function R(n){return n.split(",").map(e=>e.trim()).filter(Boolean)}function I(n){const e=n.split(/\s+as\s+/);return(e[1]||e[0]||"").trim()}function U(n){return[...n.matchAll(ot)].map(e=>({clause:e[1].trim(),modulePath:e[2].trim()}))}function C(n){const e=[];for(const r of n)e.push(r),r.type==="folder"&&e.push(...C(r.children));return e}function x(n){return n.replace(/^\/+/,"").replace(/\\/g,"/")}function Ct(n){return n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}function S(n,e){return C(n).some(r=>r.type==="file"&&e.test(x(r.path)))}function Tt(n){return C(n).some(e=>e.type==="file"&&/\.(css|scss|sass)$/i.test(e.path)&&/@tailwind\s+(base|components|utilities)\s*;/.test(e.content))}function k(n){let e=!1;const r=[];return{files:n.map(t=>{if(t.type==="folder"){const d=k(t.children);return d.changed?(e=!0,r.push(...d.repairs),{...t,children:d.files}):t}if(!$t.test(x(t.path)))return t;let s=t.content;const a=[],c=/<\/React\.StrictMode\s*>/.test(s);if(/<React\.StrictMode\b[^>]*>/.test(s)&&!c){const d=s.match(/<App\b[^>]*\/>/);if(d){const h=(d.index||0)+d[0].length;s=`${s.slice(0,h)}
  </React.StrictMode>${s.slice(h)}`,a.push("closed an unbalanced <React.StrictMode> wrapper")}}const p=/<\/StrictMode\s*>/.test(s);if(/<StrictMode\b[^>]*>/.test(s)&&!p){const d=s.match(/<App\b[^>]*\/>/);if(d){const h=(d.index||0)+d[0].length;s=`${s.slice(0,h)}
  </StrictMode>${s.slice(h)}`,a.push("closed an unbalanced <StrictMode> wrapper")}}return a.length===0?t:(e=!0,r.push(`${t.path}: ${a.join("; ")}`),{...t,content:s})}),changed:e,repairs:r}}function bt(n){return S(n,/(?:^|\/)vite\.config\.(?:[cm]?[jt]s)$/i)}function It(n){if(!bt(n)||!Tt(n))return{files:n,changed:!1,repairs:[]};const e=[...n],r=[];return S(e,/(?:^|\/)tailwind\.config\.(?:[cm]?[jt]s)$/i)||(e.push({name:"tailwind.config.js",type:"file",path:"tailwind.config.js",content:Rt}),r.push("Added missing Tailwind config for Vite CSS compilation.")),S(e,/(?:^|\/)postcss\.config\.(?:[cm]?[jt]s)$/i)||(e.push({name:"postcss.config.js",type:"file",path:"postcss.config.js",content:_t}),r.push("Added missing PostCSS config for Tailwind compilation.")),{files:e,changed:r.length>0,repairs:r}}function St(n){const e=[...n.matchAll(gt)].map(t=>({localName:t[1],statement:t[0]}));if(e.length===0)return{changed:!1,content:n};let r=!1,i=n;return e.forEach(({localName:t,statement:s})=>{const a=new RegExp(`\\b${Ct(t)}\\.createRoot\\s*\\(`,"g");if(a.test(i)){if(r=!0,a.lastIndex=0,i=i.replace(a,"createRoot("),/\bimport\s*{[^}]*\bcreateRoot\b[^}]*}\s*from\s*(["'])react-dom\/client\1;?/.test(i)){i=i.replace(s,"").replace(/\n{3,}/g,`

`);return}i=i.replace(s,'import { createRoot } from "react-dom/client";')}}),{changed:r,content:i}}function G(n){let e=!1;const r=[];return{files:n.map(t=>{if(t.type==="folder"){const a=G(t.children);return a.changed?(e=!0,r.push(...a.repairs),{...t,children:a.files}):t}if(!E.test(t.path))return t;const s=St(t.content);return s.changed?(e=!0,r.push(`${t.path}: replaced react-dom/client default createRoot usage with named createRoot import.`),{...t,content:s.content}):t}),changed:e,repairs:r}}function F(n){return x(n).replace(/\.(jsx?|tsx?|css|scss|sass|less|json)$/i,"")}function D(n){return n.replace(/\/index$/i,"")}function B(n){const e=x(n);return(e.split("/").pop()||e).replace(/\.[^.]+$/,"")}function j(n){return n.toLowerCase().replace(/(?:section|component|view|page|layout)$/g,"").replace(/s$/g,"")}function At(n){const e=n.replace(/[?#].*$/,"").trim();return e.startsWith(".")||e.startsWith("@/")||e.startsWith("~/")||e.startsWith("/")||e.startsWith("src/")}function A(n){return/\.(jsx?|tsx?)$/i.test(n)}function yt(n,e,r){const i=x(n).split("/").slice(0,-1),s=[...x(e).split("/")],a=[...i];for(;a.length>0&&s.length>0&&a[0]===s[0];)a.shift(),s.shift();let c=[...new Array(a.length).fill(".."),...s].join("/");return c?c.startsWith(".")||(c=`./${c}`):c="./",!/\.[a-z0-9]+$/i.test(r.replace(/[?#].*$/,"").trim())&&A(e)&&(c=c.replace(/\.(jsx?|tsx?)$/i,""),c=c.replace(/\/index$/i,"")),c}function X(n){const r=B(n).replace(/[^A-Za-z0-9]+/g," ").trim().split(/\s+/).filter(Boolean).map(i=>i.charAt(0).toUpperCase()+i.slice(1)).join("");return r&&/^[A-Z]/.test(r)?r:"RecoveredComponent"}function Pt(n){const e=B(n).replace(/[^A-Za-z0-9_$]/g,"");return e&&/^use[A-Z0-9_]/.test(e)?e:`use${X(n)}`}function y(n){return/^(?:src\/(?:App|main|index)\.(jsx?|tsx?)|app\/layout\.(jsx?|tsx?)|pages\/_app\.(jsx?|tsx?))$/i.test(x(n))}function Z(n){return/(?:^|\/)use[A-Z0-9][A-Za-z0-9_$-]*\.(jsx?|tsx?)$/i.test(x(n))}function v(n){const e=x(n);return y(e)||Z(e)||/^(?:src\/pages\/.+|pages\/(?!_).+|app(?:\/.+)?\/page)\.(jsx?|tsx?)$/i.test(e)||/(?:^|\/)(?:App|[^/]*Layout|Navbar|NavBar|Navigation|Header|Footer|Menu|Topbar|Sidebar|Shell)\.(jsx?|tsx?|css)$/i.test(e)}function wt(n){const e=X(n),r=x(n);if(Z(n)){const i=Pt(n);return`import React from "react";

// Auto-generated by Aura to keep the project runnable after a missing local hook import.
export function ${i}() {
  return React.useMemo(() => ({ current: null }), []);
}

export default ${i};
`}return y(n)?`import React from "react";

// Auto-generated by Aura after a required app shell file went missing during repair.
export function ${e}() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px",
        background: "#f5f5f0",
        color: "#1f2a1f",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: "560px",
          border: "1px solid rgba(31, 42, 31, 0.16)",
          background: "rgba(255, 255, 255, 0.92)",
          padding: "24px",
          boxShadow: "0 16px 50px rgba(15, 23, 15, 0.08)",
        }}
      >
        <div style={{ fontSize: "12px", letterSpacing: "0.18em", textTransform: "uppercase", opacity: 0.55 }}>
          Aura Recovery
        </div>
        <h1 style={{ margin: "16px 0 8px", fontSize: "28px", lineHeight: 1.1 }}>
          The app shell was replaced during auto-repair.
        </h1>
        <p style={{ margin: 0, fontSize: "14px", lineHeight: 1.6, opacity: 0.78 }}>
          ${r} was missing, so Aura inserted a temporary recovery
          component instead of leaving the preview blank.
        </p>
      </div>
    </div>
  );
}

export default ${e};
`:`import React from "react";

// Auto-generated by Aura to keep the project runnable after a missing local component import.
export function ${e}() {
  return null;
}

export default ${e};
`}function Nt(n,e){const r=new Map;e.forEach(o=>{const p=x(o).toLowerCase(),l=r.get(p)||[];l.push(o),r.set(p,l)});for(const o of n){const p=r.get(x(o).toLowerCase())||[];if(p.length===1)return p[0]}const i=n.find(o=>A(o))||n[0]||"",s=D(F(i)).split("/").filter(Boolean).map(o=>o.toLowerCase()),a=j(s[s.length-1]||"");if(!a)return null;const c=[...e].filter(o=>A(o)).map(o=>{const l=D(F(o)).split("/").filter(Boolean).map(g=>g.toLowerCase());if(j(l[l.length-1]||"")!==a)return null;let h=10;const f=Math.min(s.length,l.length);for(let g=1;g<=f&&s[s.length-g]===l[l.length-g];g+=1)h+=g===1?4:2;const u=s[s.length-2],m=l[l.length-2];return u&&m&&u===m&&(h+=3),{path:o,score:h}}).filter(o=>!!o).sort((o,p)=>p.score-o.score);return c.length===0?null:c.length===1||c[0].score>c[1].score?c[0].path:null}function Ft(n,e){const r=n.replace(P,(i,t,s,a)=>{const c=e.get(a.trim());return!c||c===a.trim()?i:`${t}${s}${c}${s}`});return P.lastIndex=0,r}function Dt(n,e){var o;const r=st(n,{existingFilePaths:Object.keys((e==null?void 0:e.fallbackFilesByPath)||{})});if(r.length===0)return{files:n,changed:!1,repairs:[]};const i=new Map(n.map(p=>[p.path,p.type==="folder"?{...p,children:[...p.children]}:{...p}])),t=new Set(n.filter(p=>p.type==="file").map(p=>p.path)),s=[];let a=!1;const c=new Map;for(const p of r){if(!At(p.importPath))continue;let d=p.candidatePaths.find(u=>t.has(u))||Nt(p.candidatePaths,t);if(!d){const u=p.candidatePaths.find($=>/\.(jsx|tsx)$/i.test($))||p.candidatePaths.find($=>/\.(js|ts)$/i.test($))||null;if(!u)continue;const m=x(u),g=(o=e==null?void 0:e.fallbackFilesByPath)==null?void 0:o[m];if(v(m)&&typeof g=="string"){if(!t.has(m)){const $={name:m.split("/").pop()||m,path:m,content:g,type:"file"};i.set(m,$),t.add(m),s.push(`${m}: restored the previous source file instead of generating a placeholder because ${p.path} imported a missing protected module.`),a=!0}d=m}if(!d&&v(m)&&!y(m)){s.push(`${m}: skipped placeholder creation because ${p.path} imported a missing protected module.`);continue}if(!t.has(u)){const $={name:u.split("/").pop()||u,path:u,content:wt(u),type:"file"};i.set(u,$),t.add(u),s.push(`${u}: created a fallback component because ${p.path} imported a missing local module.`),a=!0}d=u}if(!d)continue;const h=yt(p.path,d,p.importPath);if(h===p.importPath)continue;const f=c.get(p.path)||new Map;c.has(p.path)||c.set(p.path,f),f.set(p.importPath,h),s.push(`${p.path}: rewrote missing local import "${p.importPath}" to "${h}".`),a=!0}return c.forEach((p,l)=>{const d=i.get(l);!d||d.type!=="file"||i.set(l,{...d,content:Ft(d.content,p)})}),{files:Array.from(i.values()),changed:a,repairs:s}}function jt(n,e=new Set){const r=new Set;for(const{clause:i,modulePath:t}of U(n))if(!e.has(t)){if(i.startsWith("{")){const s=i.match(/^\{\s*([^}]+)\s*\}$/);if(s)for(const a of R(s[1]))r.add(I(a));continue}if(i.startsWith("* as ")){r.add(i.replace("* as ","").trim());continue}if(i.includes("{")){const[s,a]=i.split(",",2);s!=null&&s.trim()&&r.add(s.trim());const c=a==null?void 0:a.match(/\{\s*([^}]+)\s*\}/);if(c)for(const o of R(c[1]))r.add(I(o));continue}r.add(i)}return r}function vt(n){var i;const e=new Set,r=n.match(/\{\s*([^}]+)\s*\}/);if(!r)return e;for(const t of R(r[1])){const s=t.replace(/^type\s+/,"").trim();if(!s)continue;const a=(i=s.split(/\s+as\s+/)[0])==null?void 0:i.trim();a&&e.add(a)}return e}function Lt(n,e,r){const i=e.replace(/[?#].*$/,"").trim();if(!i)return null;const t=x(n).split("/").slice(0,-1),s=new Set,a=o=>{const p=x(o);p&&s.add(p)},c=o=>{const p=x(o);p&&(a(p),p.startsWith("src/")||a(`src/${p}`))};if(i.startsWith(".")){const o=[...t];for(const p of i.split("/"))if(!(!p||p===".")){if(p===".."){o.pop();continue}o.push(p)}a(o.join("/"))}else if(i.startsWith("@/")||i.startsWith("~/"))c(i.slice(2));else if(i.startsWith("/"))c(i.slice(1));else if(i.startsWith("src/")||i.includes("/"))c(i);else return null;for(const o of s){const l=(o.match(/\.(jsx?|tsx?)$/i)?[o]:[`${o}.js`,`${o}.jsx`,`${o}.ts`,`${o}.tsx`,`${o}/index.js`,`${o}/index.jsx`,`${o}/index.ts`,`${o}/index.tsx`]).find(d=>r.has(d));if(l)return l}return null}function L(n,e){if(new RegExp(ut.replace(/%s/g,e)).test(n))return!0;for(const i of n.matchAll(/\bexport\s+(type\s+)?\{([^}]+)\}/g)){if(!!i[1])continue;const s=R(i[2]||"");for(const a of s){const c=a.replace(/^type\s+/,"").trim();if(!c)continue;const o=c.split(/\s+as\s+/);if((o[1]||o[0]||"").trim()===e)return!0}}return!1}function W(n,e,r){const{includeToast:i,includeUseToast:t}=r,s=/\.tsx?$/i.test(e),a=[];return n.includes("__auraToastCompatApi")||(s?a.push("const __auraToastCompatDispatch = (..._args: unknown[]) => undefined;","const __auraToastCompatApi = Object.assign(__auraToastCompatDispatch, {","  toast: __auraToastCompatDispatch,","  success: __auraToastCompatDispatch,","  error: __auraToastCompatDispatch,","  info: __auraToastCompatDispatch,","  warning: __auraToastCompatDispatch,","  dismiss: () => undefined,","});"):a.push("const __auraToastCompatDispatch = (..._args) => undefined;","const __auraToastCompatApi = Object.assign(__auraToastCompatDispatch, {","  toast: __auraToastCompatDispatch,","  success: __auraToastCompatDispatch,","  error: __auraToastCompatDispatch,","  info: __auraToastCompatDispatch,","  warning: __auraToastCompatDispatch,","  dismiss: () => undefined,","});")),i&&a.push("export const toast = __auraToastCompatApi;"),t&&a.push("export const useToast = () => __auraToastCompatApi;"),a.join(`
`)}function Mt(n){return/\.tsx?$/i.test(n)?`
function ${_}(candidate: any) {
  const renderedChildren = (Array.isArray(candidate) ? candidate : [candidate]).filter(
    (child: any) => child !== undefined && child !== null && child !== false
  );

  if (renderedChildren.length === 1 && React.isValidElement(renderedChildren[0])) {
    return renderedChildren[0];
  }

  return <div style={{ display: "contents" }}>{renderedChildren}</div>;
}
`:`
function ${_}(candidate) {
  const renderedChildren = (Array.isArray(candidate) ? candidate : [candidate]).filter(
    (child) => child !== undefined && child !== null && child !== false
  );

  if (renderedChildren.length === 1 && React.isValidElement(renderedChildren[0])) {
    return renderedChildren[0];
  }

  return <div style={{ display: "contents" }}>{renderedChildren}</div>;
}
`}function Ot(n,e){let r=`${n}Icon`,i=2;for(;e.has(r);)r=`${n}Icon${i}`,i+=1;return r}function zt(n){const e=n.trim();if(!e||/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/i.test(e)||/^(?:\.{1,2}\/|src\/|public\/|pages\/|app\/)/i.test(e)||e.includes("{")||e.includes("}"))return null;const[r,i=""]=e.split(/(?=[?#])/,2),t=r.startsWith("/"),a=r.replace(/\\/g,"/").replace(/\/+/g,"/").replace(/^\/+/,"").split("/");if(a.length===0)return null;const c=a.length-1,o=a[c]||"";let p=!1;if(/^index\.html?$/i.test(o))return null;/\.html?$/i.test(o)&&(a[c]=o.replace(/\.html?$/i,""),p=!0);const l=a.filter(Boolean),d=l.length>0?`${t?"/":""}${l.join("/")}`:"/";return!p||d===e?null:`${d}${i}`}function b(n,e){let r=0;const i=n.replace(e,(t,s,a,c)=>{const o=zt(c);return!o||o===c?t:(r+=1,t.replace(`${a}${c}${a}`,`${a}${o}${a}`))});return e.lastIndex=0,{content:i,changes:r}}function M(n,e){let r=n;for(const[i,t]of e.entries()){const s=new RegExp(`<${i}\\b([^>]*)\\/?>`,"g");r=r.replace(s,(a,c)=>dt.test(c||"")?a:a.replace(`<${i}`,`<${t}`))}return r}function Ut(n){const e=new Set;for(const r of[it,ct,pt])for(const i of n.matchAll(r))i[1]&&e.add(i[1]);return e}function H(n,e=new Set){for(const r of n){if(r.type==="folder"){H(r.children,e);continue}const t=(r.path.split("/").pop()||"").replace(/\.[^.]+$/,"");/^[A-Z][A-Za-z0-9_]*$/.test(t)&&e.add(t)}return e}function kt(n,e){const r=n.match(T);if(!r)return{content:n,changed:!1,repairedIcons:[],aliasedIcons:[]};const i=jt(n,new Set(["lucide-react"])),t=Ut(n),s=new Set([...i,...t]),a=R(r[1]),c=new Set,o=[],p=new Map,l=[];for(const f of a){const m=(f.split(/\s+as\s+/)[0]||"").trim(),g=I(f);let $=g;(s.has(g)||c.has(g))&&($=Ot(m,new Set([...s,...c])),p.set(g,$),o.push(`${m} as ${$}`)),c.add($),s.add($),l.push(m===$?m:`${m} as ${$}`)}const d=new Set;for(const f of n.matchAll(lt)){const u=f[1],m=f[2]||"";s.has(u)||c.has(u)||e.has(u)||at.has(u)||/\b(size|strokeWidth)\s*=/.test(m)&&d.add(u)}if(d.size===0){if(p.size===0)return{content:n,changed:!1,repairedIcons:[],aliasedIcons:[]};const f=`import { ${l.join(", ")} } from ${r[2]}lucide-react${r[2]};`;return{content:M(n.replace(T,f),p),changed:!0,repairedIcons:[],aliasedIcons:o}}for(const f of d)c.has(f)||l.push(f);const h=`import { ${l.join(", ")} } from ${r[2]}lucide-react${r[2]};`;return{content:M(n.replace(T,h),p),changed:p.size>0||d.size>0,repairedIcons:[...d],aliasedIcons:o}}function V(n,e){let r=!1;const i=[];return{files:n.map(s=>{if(s.type==="folder"){const c=V(s.children,e);return c.changed?(r=!0,i.push(...c.repairs),{...s,children:c.files}):s}if(!E.test(s.path))return s;const a=kt(s.content,e);return a.changed?(r=!0,a.repairedIcons.length>0&&i.push(`${s.path}: added missing lucide-react imports (${a.repairedIcons.join(", ")})`),a.aliasedIcons.length>0&&i.push(`${s.path}: aliased conflicting lucide-react imports (${a.aliasedIcons.join(", ")})`),{...s,content:a.content}):s}),changed:r,repairs:i}}function J(n){let e=!1;const r=[];return{files:n.map(t=>{if(t.type==="folder"){const c=J(t.children);return c.changed?(e=!0,r.push(...c.repairs),{...t,children:c.files}):t}if(!E.test(t.path))return t;const s=t.content.replace(w,`${_}($1)`);if(w.lastIndex=0,s===t.content)return t;e=!0,r.push(`${t.path}: relaxed strict Children.only usage so multi-child wrappers do not crash the preview.`);const a=s.includes(`function ${_}`)?s:`${s.trimEnd()}
${Mt(t.path)}`;return{...t,content:`${a.trimEnd()}
`}}),changed:e,repairs:r}}function Y(n){let e=!1;const r=[];return{files:n.map(t=>{if(t.type==="folder"){const p=Y(t.children);return p.changed?(e=!0,r.push(...p.repairs),{...t,children:p.files}):t}if(!E.test(t.path))return t;const s=b(t.content,ht),a=b(s.content,ft),c=b(a.content,mt),o=s.changes+a.changes+c.changes;return o===0?t:(e=!0,r.push(`${t.path}: normalized ${o} generated route literal${o===1?"":"s"} to remove trailing .html suffixes.`),{...t,content:c.content})}),changed:e,repairs:r}}function K(n){let e=!1;const r=[];return{files:n.map(t=>{if(t.type==="folder"){const l=K(t.children);return l.changed?(e=!0,r.push(...l.repairs),{...t,children:l.files}):t}if(!E.test(t.path))return t;const s=[...new Set(rt(t.path,t.content).filter(l=>l.attribute==="onSubmit").map(l=>l.identifier))];if(s.length===0)return t;const a=/\.tsx?$/i.test(t.path),c=s.map(l=>a?`  const ${l} = (event: { preventDefault: () => void }) => {
    event.preventDefault();
  };`:`  const ${l} = (event) => {
    event.preventDefault();
  };`).join(`

`),o=t.content.replace(O,`$1
${c}
`),p=o===t.content?t.content.replace(z,`$1
${c}
`):o;return p===t.content?t:(e=!0,r.push(`${t.path}: added missing form submit handler${s.length===1?"":"s"} (${s.join(", ")}).`),{...t,content:p})}),changed:e,repairs:r}}function Gt(n){return n&&`${n[0].toLowerCase()}${n.slice(1)}`}function Q(n){let e=!1;const r=[];return{files:n.map(t=>{var m;if(t.type==="folder"){const g=Q(t.children);return g.changed?(e=!0,r.push(...g.repairs),{...t,children:g.files}):t}if(!E.test(t.path))return t;const s=(m=t.content.match(N))==null?void 0:m[1];if(!s)return t;const a=t.content.search(N),c=a>=0?t.content.slice(0,a):t.content,o=new RegExp(`\\b(const|let|var)\\s+${s}\\s*=\\s*(\\[|\\{|new\\s+(?:Map|Set)\\b)`,"m"),p=new RegExp(`\\bfunction\\s+${s}\\s*\\(|\\b(?:const|let|var)\\s+${s}\\s*=`,"m");if(!o.test(t.content)&&!p.test(c))return t;const l=o.test(t.content),d=l?`${Gt(s)}Data`:`${s}Section`;let h=d,f=2;for(;new RegExp(`\\b${h}\\b`).test(t.content);)h=`${d}${f}`,f+=1;let u=t.content;if(l)u=u.replace(o,(g,$,nt)=>`${$} ${h} = ${nt}`),u=u.replace(new RegExp(`\\b${s}\\b(?=\\s*(?:\\.|\\[))`,"g"),h);else{const g=c.replace(p,$=>$.replace(s,h));u=a>=0?`${g}${t.content.slice(a)}`:g,u=u.replace(new RegExp(`(<\\/?\\s*)${s}\\b`,"g"),`$1${h}`)}return u===t.content?t:(e=!0,r.push(`${t.path}: renamed duplicate ${s} ${l?"data declaration":"component declaration"} to ${h}.`),{...t,content:u})}),changed:e,repairs:r}}function q(n,e){return new RegExp(`\\b(?:const|let|var|function|class)\\s+${e}\\b|\\b(?:const|let|var)\\s*\\[[^\\]]*\\b${e}\\b[^\\]]*\\]|\\b(?:const|let|var)\\s*{[^}]*\\b${e}\\b[^}]*}|\\bimport\\s+${e}\\b|\\bimport\\s*{[^}]*\\b${e}\\b[^}]*}\\s+from`,"m").test(n)}function Bt(n){return/\bimport\s+React\b/.test(n)||/\bimport\s+\*\s+as\s+React\s+from\s+["']react["']/.test(n)?n:`import React from "react";
${n}`}function tt(n){let e=!1;const r=[];return{files:n.map(t=>{if(t.type==="folder"){const l=tt(t.children);return l.changed?(e=!0,r.push(...l.repairs),{...t,children:l.files}):t}if(!E.test(t.path))return t;const s=[...new Set([...t.content.matchAll(xt)].map(l=>l[1]).filter(l=>{const d=`set${l[0].toUpperCase()}${l.slice(1)}`;return!q(t.content,l)&&new RegExp(`\\b${d}\\b`).test(t.content)}))];if(s.length===0)return t;const a=s.map(l=>{const d=`set${l[0].toUpperCase()}${l.slice(1)}`;return`  const [${l}, ${d}] = React.useState("");`}).join(`
`),c=Bt(t.content),o=c.replace(O,`$1
${a}
`),p=o===c?c.replace(z,`$1
${a}
`):o;return p===t.content?t:(e=!0,r.push(`${t.path}: added missing controlled input state for ${s.join(", ")}.`),{...t,content:p})}),changed:e,repairs:r}}function et(n){let e=!1;const r=[];return{files:n.map(t=>{if(t.type==="folder"){const a=et(t.children);return a.changed?(e=!0,r.push(...a.repairs),{...t,children:a.files}):t}if(!E.test(t.path)||!Et.test(t.content)||q(t.content,"toast"))return t;const s=W(t.content,t.path,{includeToast:!0,includeUseToast:!1}).replace(/\bexport\s+const\s+toast\b/,"const toast");return s?(e=!0,r.push(`${t.path}: added missing local toast compatibility shim.`),{...t,content:`${s}

${t.content}`}):t}),changed:e,repairs:r}}function Ht(n,e){const r=V(n,H(n)),i=Dt(r.files,e),t=J(i.files),s=Y(t.files),a=k(s.files),c=G(a.files),o=Xt(c.files),p=K(o.files),l=Q(p.files),d=tt(l.files),h=et(d.files),f=It(h.files);return{files:f.files,changed:r.changed||i.changed||t.changed||s.changed||a.changed||c.changed||o.changed||p.changed||l.changed||d.changed||h.changed||f.changed,repairs:[...r.repairs,...i.repairs,...t.repairs,...s.repairs,...a.repairs,...c.repairs,...o.repairs,...p.repairs,...l.repairs,...d.repairs,...h.repairs,...f.repairs]}}function Xt(n){const e=C(n).filter(c=>c.type==="file"&&E.test(c.path)),r=new Set(e.map(c=>x(c.path))),i=new Map;for(const c of e)for(const{clause:o,modulePath:p}of U(c.content)){const l=vt(o),d=l.has("useToast"),h=l.has("toast");if(!d&&!h)continue;const f=Lt(c.path,p,r);if(!f)continue;const u=i.get(f)||{needsToast:!1,needsUseToast:!1,consumers:new Set};u.needsToast||(u.needsToast=h),u.needsUseToast||(u.needsUseToast=d),u.consumers.add(c.path),i.set(f,u)}if(i.size===0)return{files:n,changed:!1,repairs:[]};let t=!1;const s=[],a=c=>c.map(o=>{if(o.type==="folder")return{...o,children:a(o.children)};if(!E.test(o.path))return o;const p=x(o.path),l=i.get(p);if(!l)return o;const d=l.needsUseToast&&!L(o.content,"useToast"),h=l.needsToast&&!L(o.content,"toast");if(!d&&!h)return o;t=!0,s.push(`${o.path}: added missing toast compatibility export${d&&h?"s (toast, useToast)":d?" (useToast)":" (toast)"} for ${[...l.consumers].join(", ")}`);const f=W(o.content,o.path,{includeToast:h,includeUseToast:d});return{...o,content:`${o.content.trimEnd()}

${f}
`}});return{files:a(n),changed:t,repairs:s}}export{Ht as repairReactProjectFiles};
