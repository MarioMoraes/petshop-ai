const $=/^src\/App\.(jsx?|tsx?)$/i,H=/^src\/(?:main|index)\.(jsx?|tsx?)$/i,F=/^src\/pages\/(.+)\.(jsx?|tsx?)$/i,k=/^pages\/(.+)\.(jsx?|tsx?)$/i,j=/^app(?:\/(.+))?\/page\.(jsx?|tsx?)$/i,Z=["src/index.css","src/App.css","src/app.css","src/global.css","src/globals.css","app/globals.css"],Y=/\.(css|scss|sass|less)$/i,h="src/__aura_page_preview__.jsx",J=new Set(["_app","_document","_error"]),N=[/from\s+["']react-router-dom["']/,/\bBrowserRouter\b/,/\bHashRouter\b/,/\bRouterProvider\b/,/\bcreateBrowserRouter\b/,/\bRoutes\b/,/\bRoute\b/],y=/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?/g,I=/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.)?lazy\(\s*\(\s*\)\s*=>\s*import\(\s*["']([^"']+)["']\s*\)\s*\)/g,U=[/import\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["'];?/g,/export\s+[^"'`]*?\s+from\s+["']([^"']+)["'];?/g,/import\s*\(\s*["']([^"']+)["']\s*\)/g,/require\(\s*["']([^"']+)["']\s*\)/g],M=/<Route\b(?:[^"'>{}]|"[^"]*"|'[^']*'|{[\s\S]*?})*(?:\/>|>[\s\S]*?<\/Route>)/g,K=/\bpath\s*=\s*["']([^"']+)["']/,q=/\belement\s*=\s*{\s*<([A-Za-z_$][\w$]*)\b/,z=/\bComponent\s*=\s*{\s*([A-Za-z_$][\w$]*)\s*}/,O=/{[\s\S]*?\bpath\s*:\s*["']([^"']+)["'][\s\S]*?\belement\s*:\s*<([A-Za-z_$][\w$]*)\b[\s\S]*?}/g,Q=[/\bBrowserRouter\b/,/\bHashRouter\b/,/\bRouterProvider\b/,/\bcreateBrowserRouter\b/],E=t=>{const o=[],n=e=>{if(e.type==="file"){o.push(e);return}e.children.forEach(n)};return t.forEach(n),o},S=t=>t.replace(/\.(jsx?|tsx?)$/i,""),tt=t=>t.replace(/\[(.+?)\]/g,"$1").replace(/[^a-zA-Z0-9/_-]+/g,"").replace(/\/+/g,"/").replace(/^-+|-+$/g,"").toLowerCase(),x=t=>{const n=S(t).replace(/\\/g,"/").split("/").filter(Boolean);if(n.length===0)return"/";const e=n.filter((r,a,s)=>{const i=r.toLowerCase();return!(i==="index"||s.length===1&&i==="home")});return e.length===0?"/":`/${e.map(tt).join("/")}`},w=t=>{const o=v(t||"/");if(o==="/")return"/";const[n,e=""]=o.split(/(?=[?#])/,2),r=n.replace(/\/+/g,"/").replace(/\/$/,"")||"/";if(r==="/")return"/";const a=r.replace(/^\//,"").split("/"),s=a.length-1;return s>=0&&(a[s]=a[s].replace(/\.html?$/i,"")),`${`/${a.filter(Boolean).join("/")}`||"/"}${e}`},b=(t,o,n)=>{if(!o.startsWith("."))return null;const e=t.split("/").slice(0,-1),r=o.split("/"),a=[...e];r.forEach(l=>{if(!(!l||l===".")){if(l===".."){a.pop();return}a.push(l)}});const s=a.join("/").replace(/\\/g,"/");return(s.match(/\.(jsx?|tsx?)$/i)?[s]:[`${s}.js`,`${s}.jsx`,`${s}.ts`,`${s}.tsx`,`${s}/index.js`,`${s}/index.jsx`,`${s}/index.ts`,`${s}/index.tsx`]).find(l=>n.has(l))||null},et=(t,o,n)=>{const e=new Set;return U.forEach(r=>{r.lastIndex=0;let a=null;for(;(a=r.exec(o))!==null;){const[,s]=a;if(!(s!=null&&s.startsWith(".")))continue;const i=b(t,s,n);i&&e.add(i)}}),[...e]},B=(t,o)=>{const n=E(o).filter(i=>/\.(jsx?|tsx?)$/i.test(i.path)),e=new Set(n.map(i=>i.path)),r=new Map(n.map(i=>[i.path,i.content]));if(!e.has(t))return!1;const a=[t],s=new Set;for(;a.length>0;){const i=a.pop();if(!i||s.has(i))continue;s.add(i);const l=r.get(i);if(l){if(Q.some(d=>d.test(l)))return!0;et(i,l,e).forEach(d=>{s.has(d)||a.push(d)})}}return!1},ot=t=>j.test(t)?"app":F.test(t)?"src-pages":"pages",L=t=>/^[A-Za-z_$][\w$]*$/.test(t),nt=t=>{const o=t.replace(/^type\s+/,"").trim(),n=o.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);return n?n[2]:L(o)?o:null},rt=(t,o,n)=>{var a;const e=new Map;let r=null;for(y.lastIndex=0;(r=y.exec(o))!==null;){const[,s,i]=r,l=b(t,i,n);if(!l)continue;const d=s.trim();if(d.startsWith("type "))continue;const c=d.match(/{([\s\S]*?)}/),u=(a=d.split(",")[0])==null?void 0:a.trim().replace(/^type\s+/,"");u&&!u.startsWith("{")&&!u.startsWith("*")&&L(u)&&e.set(u,l),c&&c[1].split(",").map(p=>nt(p)).filter(p=>!!p).forEach(p=>{e.set(p,l)})}for(I.lastIndex=0;(r=I.exec(o))!==null;){const[,s,i]=r,l=b(t,i,n);l&&e.set(s,l)}return e},v=t=>{const o=t.trim();return!o||o==="index"?"/":o.startsWith("/")?o:`/${o}`},st=(t,o)=>{const n=t.match(/\belement\s*=\s*{\s*([\s\S]*?)\s*}/),e=t.match(z);return((n==null?void 0:n[1])||(e==null?void 0:e[0])||o).replace(/\s+/g," ").trim()},at=t=>{const o=new Map;t.forEach(e=>{if(e.isImportedComponent)return;const r=[e.routeOwnerFilePath,e.componentFilePath,e.componentName,e.elementSignature].join("|");o.set(r,[...o.get(r)||[],e])});const n=new Set;return o.forEach(e=>{if(e.length<=1)return;const r=e.find(a=>a.routePath==="/")||e[0];e.forEach(a=>{a!==r&&n.add(a)})}),t.filter(e=>!n.has(e))},it=t=>{const o=new Set(t.map(r=>r.path)),n=new Map,e=[];return t.forEach(r=>{var i,l,d;if(!/\.(jsx?|tsx?)$/i.test(r.path)||!N.some(c=>c.test(r.content)))return;const a=rt(r.path,r.content,o);let s=null;for(M.lastIndex=0;(s=M.exec(r.content))!==null;){const[c]=s,u=(i=c.match(K))==null?void 0:i[1],p=((l=c.match(q))==null?void 0:l[1])||((d=c.match(z))==null?void 0:d[1]),P=u?v(u):null;if(!P||!p||P.includes(":")||P.includes("*"))continue;const f=a.get(p)||null,m=f||(o.has(r.path)?r.path:null);m&&e.push({routePath:P,componentName:p,componentFilePath:m,routeOwnerFilePath:r.path,elementSignature:st(c,p),isImportedComponent:!!f})}for(O.lastIndex=0;(s=O.exec(r.content))!==null;){const[,c,u]=s,p=c?v(c):null;if(!p||!u||p.includes(":")||p.includes("*"))continue;const P=a.get(u)||null,f=P||(o.has(r.path)?r.path:null);f&&e.push({routePath:p,componentName:u,componentFilePath:f,routeOwnerFilePath:r.path,elementSignature:u,isImportedComponent:!!P})}}),at(e).forEach(r=>{const a=n.get(r.componentFilePath)||[];a.includes(r.routePath)||n.set(r.componentFilePath,[...a,r.routePath])}),n},G=(t,o)=>{if(t==="/")return"Home";const n=t.replace(/^\//,"").split("/").filter(Boolean).map(e=>e.replace(/[-_]+/g," ").replace(/\b\w/g,r=>r.toUpperCase())).join(" / ");return n||S(o.split("/").pop()||o)},ct={"src-pages":3,pages:2,app:1},C=t=>{const o=w(t.routePath);let n=ct[t.kind]*10;return t.routePath===o&&(n+=5),t.isDefault&&(n+=1),n},g=(t,o)=>{const n=t.split("/").slice(0,-1),e=o.split("/");for(;n.length>0&&e.length>0&&n[0]===e[0];)n.shift(),e.shift();const a=[...new Array(n.length).fill(".."),...e].join("/");return!a||a===""?"./":a.startsWith(".")?a:`./${a}`},lt=(t,o,n)=>{var s;const e=((s=o.split(/[?#]/,1)[0])==null?void 0:s.trim())||"";if(!Y.test(e))return null;if(e.startsWith("@/")){const i=`src/${e.slice(2)}`;return n.has(i)?i:null}if(e.startsWith("/")){const i=e.replace(/^\/+/,"");return n.has(i)?i:null}if(!e.startsWith("."))return n.has(e)?e:null;const r=t.split("/").slice(0,-1);e.split("/").forEach(i=>{if(!(!i||i===".")){if(i===".."){r.pop();return}r.push(i)}});const a=r.join("/").replace(/\\/g,"/");return n.has(a)?a:null},V=(t,o,n)=>{const e=E(t).find(a=>a.path===o),r=new Set;return e&&U.forEach(a=>{a.lastIndex=0;let s=null;for(;(s=a.exec(e.content))!==null;){const i=lt(o,s[1]||"",n);i&&r.add(i)}}),r.size>0?[...r]:Z.filter(a=>n.has(a))},T=t=>t.map(o=>`import "${g(h,o)}";`).join(`
`),ut=(t,o)=>{const n=g(h,t.previewFilePath),e=T(o);return`import React from "react";
import { MemoryRouter } from "react-router-dom";
import * as PageModule from "${n}";
${e}

const resolvedPagePath = ${JSON.stringify(t.routePath)};
const previewRouterFuture = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
};
const resolvedPageModule =
  PageModule.default ||
  Object.values(PageModule).find((value) => typeof value === "function");

const FallbackPage = () => (
  <div style={{ padding: "24px", fontFamily: "Inter, sans-serif" }}>
    The selected page file does not export a React component.
  </div>
);

const PreviewPage = resolvedPageModule || FallbackPage;

export default function AuraPagePreview() {
  React.useEffect(() => {
    try {
      window.history.replaceState({}, "", resolvedPagePath);
    } catch (error) {
      console.warn("Unable to set preview path", error);
    }
  }, []);

  return (
    <MemoryRouter
      initialEntries={[resolvedPagePath]}
      future={previewRouterFuture}
    >
      <PreviewPage />
    </MemoryRouter>
  );
}`},W=(t,o,n)=>{const e=g(h,t),r=T(o);return`import React from "react";
${n?'import { BrowserRouter } from "react-router-dom";':""}
import * as AppModule from "${e}";
${r}

const PREVIEW_SANDBOX_PATH = "/preview-sandbox-v2.html";
const previewRouterFuture = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
};
const getCurrentBrowserPath = () =>
  \`\${window.location.pathname || "/"}\${window.location.search || ""}\${window.location.hash || ""}\`;
const normalizePreviewPath = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return "/";
  }

  const trimmedValue = value.trim();
  return trimmedValue.startsWith("/") ? trimmedValue : \`/\${trimmedValue}\`;
};
const resolvedPagePath = (() => {
  const browserPath = getCurrentBrowserPath();
  if (browserPath && browserPath !== PREVIEW_SANDBOX_PATH) {
    return browserPath;
  }

  return normalizePreviewPath(window.__AURA_PREVIEW_ROUTE_PATH || "/");
})();
const resolvedAppModule =
  AppModule.default ||
  Object.values(AppModule).find((value) => typeof value === "function");

try {
  if (getCurrentBrowserPath() !== resolvedPagePath) {
    window.history.replaceState({}, "", resolvedPagePath);
  }
} catch (error) {
  console.warn("Unable to set preview path", error);
}

const FallbackApp = () => (
  <div style={{ padding: "24px", fontFamily: "Inter, sans-serif" }}>
    The routed app entry does not export a React component.
  </div>
);

const PreviewApp = resolvedAppModule || FallbackApp;

export default function AuraRoutePreview() {
  const app = <PreviewApp />;

  ${n?"return <BrowserRouter future={previewRouterFuture}>{app}</BrowserRouter>;":"return app;"}
}
`},pt=(t,o,n)=>{const e=[],r=[];t.forEach((s,i)=>{if(!o.has(s.previewFilePath))return;const l=`PageModule${i}`;e.push(`import * as ${l} from "${g(h,s.previewFilePath)}";`),r.push(`${JSON.stringify(s.routePath)}: ${l}`)});const a=T(n);return`import React from "react";
import { MemoryRouter } from "react-router-dom";
${e.join(`
`)}
${a}

const previewRouterFuture = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
};
const ROUTE_MODULES = {
  ${r.join(`,
  `)}
};
const normalizeRoutePath = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return "/";
  }

  try {
    const parsed = new URL(value, window.location.origin);
    const normalizedPathname =
      parsed.pathname.replace(/\\/+/g, "/").replace(/\\/$/, "") || "/";

    return \`\${normalizedPathname}\${parsed.search}\${parsed.hash}\`;
  } catch (error) {
    const trimmedValue = value.trim();
    return trimmedValue.startsWith("/") ? trimmedValue : \`/\${trimmedValue}\`;
  }
};
const getCurrentRoutePath = () =>
  normalizeRoutePath(
    window.location.pathname ||
      window.__AURA_PREVIEW_ROUTE_PATH ||
      "/",
  );
const resolveRouteModule = (routePath) => {
  if (ROUTE_MODULES[routePath]) {
    return ROUTE_MODULES[routePath];
  }

  if (ROUTE_MODULES["/"]) {
    return ROUTE_MODULES["/"];
  }

  return Object.values(ROUTE_MODULES)[0] || null;
};
const resolveRenderableModule = (moduleValue) =>
  moduleValue?.default ||
  Object.values(moduleValue || {}).find((value) => typeof value === "function");

const FallbackPage = () => (
  <div style={{ padding: "24px", fontFamily: "Inter, sans-serif" }}>
    The current route could not be resolved in this published preview.
  </div>
);

export default function AuraPublishedPagePreview() {
  const resolvedRoutePath = getCurrentRoutePath();
  const resolvedPageModule = resolveRouteModule(resolvedRoutePath);
  const PreviewPage = resolveRenderableModule(resolvedPageModule) || FallbackPage;

  return (
    <MemoryRouter
      initialEntries={[resolvedRoutePath]}
      future={previewRouterFuture}
    >
      <PreviewPage />
    </MemoryRouter>
  );
}
`},X=t=>E(t).some(o=>o.type==="file"&&/\.(jsx?|tsx?)$/i.test(o.path)&&N.some(n=>n.test(o.content))),ht=t=>{const o=E(t),n=o.find(r=>H.test(r.path));if(n)return n.path;const e=o.find(r=>$.test(r.path));return e?e.path:"src/App.jsx"},D=t=>{const n=E(t).find(e=>$.test(e.path));return(n==null?void 0:n.path)||null},dt=(t,o,n)=>{const e=E(t),r=new Set(E(o).map(c=>c.path)),a=new Map,s=it(e),i=s.size>0,l=(c,u,p,P,f=!1)=>{if(!r.has(p))return;const m=v(c||"/"),R=w(m),_={id:`${P}:${u}:${m}`,label:G(R,u),routePath:m,codeFilePath:u,previewFilePath:p,kind:P,isDefault:f},A=a.get(R);A&&C(A)>=C(_)||a.set(R,_)},d=[...e].sort((c,u)=>c.path.localeCompare(u.path));if(d.forEach(c=>{const u=s.get(c.path)||[];if(u.length>0){u.forEach(m=>l(m,c.path,c.path,ot(c.path),m==="/"));return}const p=c.path.match(j);if(p){const m=p[1]||"",R=x(m),_=R==="/"&&r.has(n)?n:c.path;l(R,c.path,_,"app",R==="/");return}const P=c.path.match(F);if(P){if(i)return;const m=x(P[1]||"");l(m,c.path,c.path,"src-pages",m==="/");return}const f=c.path.match(k);if(f){const m=f[1]||"",R=S(m.split("/").pop()||"");if(J.has(R.toLowerCase()))return;const _=x(m);l(_,c.path,c.path,"pages",_==="/")}}),a.size===0){const c=d.find(u=>$.test(u.path));c&&l("/",c.path,c.path,"app",!0)}return[...a.values()].sort((c,u)=>{const p=w(c.routePath),P=w(u.routePath);return p==="/"?-1:P==="/"?1:p.localeCompare(P)})},mt=(t,o)=>t.find(n=>n.codeFilePath===o||n.previewFilePath===o)||null,Pt=(t,o,n)=>{const e=new Set(E(t).map(l=>l.path)),r=e.has(n)&&X(t),a=V(t,n,e),s=D(t);if(o&&r&&s){const l=B(s,t),d=s!==n&&!l;return{files:[...t.filter(u=>u.type!=="file"||u.path!==h),{name:h.split("/").pop()||"__aura_page_preview__.jsx",path:h,content:W(s,a,d),type:"file"}],mainFile:h,previewPath:o.routePath,hiddenCodeFiles:[h]}}return!o||o.previewFilePath===n||o.routePath==="/"&&o.codeFilePath===n?{files:t,mainFile:n,previewPath:(o==null?void 0:o.routePath)||"/",hiddenCodeFiles:[]}:e.has(o.previewFilePath)?{files:[...t.filter(l=>l.type!=="file"||l.path!==h),{name:h.split("/").pop()||"__aura_page_preview__.jsx",path:h,content:ut(o,a),type:"file"}],mainFile:h,previewPath:o.routePath,hiddenCodeFiles:[h]}:{files:t,mainFile:n,previewPath:o.routePath,hiddenCodeFiles:[]}},ft=(t,o,n)=>{const e=new Set(E(t).map(d=>d.path)),r=e.has(n)&&X(t),a=V(t,n,e),s=D(t);if(r&&s&&e.has(s)){const d=B(s,t),c=s!==n&&!d;return{files:[...t.filter(p=>p.type!=="file"||p.path!==h),{name:h.split("/").pop()||"__aura_page_preview__.jsx",path:h,content:W(s,a,c),type:"file"}],mainFile:h,previewPath:"/",hiddenCodeFiles:[h]}}const i=o.length>0?o:s&&e.has(s)?[{id:`app:${s}:/`,label:G("/",s),routePath:"/",codeFilePath:s,previewFilePath:s,kind:"app",isDefault:!0}]:[];return i.length===0?{files:t,mainFile:n,previewPath:"/",hiddenCodeFiles:[]}:{files:[...t.filter(d=>d.type!=="file"||d.path!==h),{name:h.split("/").pop()||"__aura_page_preview__.jsx",path:h,content:pt(i,e,a),type:"file"}],mainFile:h,previewPath:"/",hiddenCodeFiles:[h]}};export{ft as buildPublishedReactArtifactEntry,Pt as buildReactProjectPreviewEntry,dt as deriveReactProjectPages,mt as getReactPageForFile,ht as getReactRuntimeEntryFile};
