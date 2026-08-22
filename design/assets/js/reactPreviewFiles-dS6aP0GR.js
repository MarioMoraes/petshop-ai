const x=["index.html","public/index.html"],u=`export default function App() {
  return <div>React project preview</div>;
}
`,h=i=>{const c=[];return i.forEach(e=>{if(e.type==="file"){c.push({path:e.path,content:e.content});return}c.push(...h(e.children))}),c},f=i=>{const c=h(i);return Object.fromEntries(x.flatMap(e=>{const n=c.find(r=>r.path===e);return n?[[e,n.content]]:[]}))},j=i=>{var o,a,l;const c=i.find(t=>t.type==="file"&&t.path==="index.html"),e=i.filter(t=>t.path!=="index.html"&&t.path!=="vite.config.js"&&t.path!=="vite.config.ts"&&t.path!=="postcss.config.js").map(t=>t.type==="folder"?{...t,children:[...t.children]}:{...t}),n=t=>e.find(d=>d.type==="file"&&d.path===t);if(!n("public/index.html")){let t=`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>React Project</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;c&&c.type==="file"&&(t=c.content.replace(/<script[^>]*type=["']module["'][^>]*src=["'][^"']*["'][^>]*>\s*<\/script>/gi,"").replace(/<script[^>]*src=["'][^"']*main\.(jsx|tsx|js)["'][^>]*>\s*<\/script>/gi,"")),e.push({name:"index.html",path:"public/index.html",content:t,type:"file"})}const m=n("src/index.js"),p=n("src/main.jsx")||n("src/main.tsx")||n("src/index.tsx"),s=((o=n("src/App.jsx"))==null?void 0:o.path)||((a=n("src/App.tsx"))==null?void 0:a.path)||((l=n("src/App.js"))==null?void 0:l.path)||"src/App.jsx";if(n(s)||e.push({name:"App.jsx",path:"src/App.jsx",content:u,type:"file"}),!m){let t=`import React from 'react';
	import { createRoot } from 'react-dom/client';
	import App from './${s.replace("src/","")}';
	import './index.css';

	createRoot(document.getElementById('root')).render(
	  <React.StrictMode>
	    <App />
	  </React.StrictMode>
);`;p&&p.type==="file"&&(t=p.content.replace(/\bas HTMLElement\b/g,"").replace(/\bas HTMLDivElement\b/g,"")),e.push({name:"index.js",path:"src/index.js",content:t,type:"file"})}return e};export{j as buildReactPreviewFiles,f as extractReactDocumentShellModules};
