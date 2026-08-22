function A(s){const r=s.some(c=>c.path==="vite.config.js"||c.path==="vite.config.ts"),t=s.some(c=>c.path==="next.config.js"||c.path==="app/layout.tsx"),i=s.some(c=>c.path==="public/index.html"),o=s.some(c=>c.path==="index.html");return t?"nextjs":r||o?"react-vite":i?"react-cra":"react-vite"}function S(s,r){const t=A(s);return t===r?s:t==="react-cra"&&r==="react-vite"?b(s):t==="react-vite"&&r==="react-cra"?v(s):(console.warn(`Conversion from ${t} to ${r} not yet implemented`),s)}function b(s){var e,p;const r=[],t=s.find(n=>n.path==="package.json");if(t&&t.type==="file")try{const n=JSON.parse(t.content),d={name:n.name||"vite-react-app",version:n.version||"0.1.0",private:!0,type:"module",scripts:{dev:"vite",build:"vite build",preview:"vite preview"},dependencies:{...Object.fromEntries(Object.entries(n.dependencies||{}).filter(([h])=>h!=="react-scripts")),react:((e=n.dependencies)==null?void 0:e.react)||"^18.3.1","react-dom":((p=n.dependencies)==null?void 0:p["react-dom"])||"^18.3.1"},devDependencies:{"@types/react":"^18.3.3","@types/react-dom":"^18.3.0","@vitejs/plugin-react":"^4.3.4",vite:"^5.4.10"}};r.push({name:"package.json",type:"file",path:"package.json",content:JSON.stringify(d,null,2),children:[]})}catch(n){console.error("Failed to convert package.json:",n)}const i=s.find(n=>n.path==="public/index.html");if(i&&i.type==="file"){let n=i.content;n=n.replace("%PUBLIC_URL%/","/"),n=n.replace("</body>",`    <script type="module" src="/src/main.jsx"><\/script>
  </body>`),r.push({name:"index.html",type:"file",path:"index.html",content:n,children:[]})}const o=s.find(n=>n.path==="src/index.js"||n.path==="src/index.tsx");if(o&&o.type==="file"){let n=o.content;n=n.replace("from './App'","from './App.jsx'"),n=n.replace("from './App.js'","from './App.jsx'"),r.push({name:"main.jsx",type:"file",path:"src/main.jsx",content:n,children:[]})}const c=s.find(n=>n.path==="src/App.js"||n.path==="src/App.tsx");return c&&c.type==="file"&&r.push({name:"App.jsx",type:"file",path:"src/App.jsx",content:c.content,children:[]}),r.push({name:"vite.config.js",type:"file",path:"vite.config.js",content:`import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000
  },
  build: {
    outDir: 'dist'
  }
})`,children:[]}),s.forEach(n=>{n.type==="file"&&!n.path.includes("index.html")&&!n.path.includes("package.json")&&!n.path.includes("src/index.")&&!n.path.includes("src/App.")&&!n.path.includes("public/")&&r.push(n)}),r}function v(s){const r=[],t=s.find(e=>e.path==="package.json");if(t&&t.type==="file")try{const e=JSON.parse(t.content),p={name:e.name,version:"0.1.0",private:!0,dependencies:{react:"^18.2.0","react-dom":"^18.2.0","react-scripts":"5.0.1",...e.dependencies},scripts:{start:"react-scripts start",build:"react-scripts build",test:"react-scripts test",eject:"react-scripts eject"}};r.push({name:"package.json",type:"file",path:"package.json",content:JSON.stringify(p,null,2)})}catch{}const i=s.find(e=>e.path==="index.html");if(i&&i.type==="file"){let e=i.content;e=e.replace("/src/main.jsx",""),e=e.replace("/src/main.tsx",""),r.push({name:"index.html",type:"file",path:"public/index.html",content:e})}const o=s.find(e=>e.path==="src/main.jsx"||e.path==="src/main.tsx");if(o&&o.type==="file"){let e=o.content;e=e.replace("from './App.jsx'","from './App'"),e=e.replace("from './App.tsx'","from './App'"),r.push({name:"index.js",type:"file",path:"src/index.js",content:e})}const c=s.find(e=>e.path==="src/App.jsx"||e.path==="src/App.tsx");if(c&&c.type==="file"){let e=c.content;e=e.replace("from './lib/utils.js'","from './lib/utils'"),r.push({name:"App.js",type:"file",path:"src/App.js",content:e})}return s.forEach(e=>{if(e.type==="file"&&e.path.startsWith("src/")&&!e.path.includes("main.")&&!e.path.includes("App.")){let p=e.path,n=e.content;p=p.replace(/\.jsx$/,".js").replace(/\.tsx$/,".js"),n=n.replace(/from ['"]([^'"]*?)\.js['"]/g,"from '$1'"),r.push({...e,path:p,content:n})}}),s.forEach(e=>{e.type==="file"&&(e.path.endsWith(".css")||e.path.endsWith(".scss"))&&r.push(e)}),r}const R=v;function w(s){var d,h,u,f,x,g;if(!s.some(a=>a.path==="app/layout.tsx"||a.path==="next.config.js"))return s;const t=[],i=s.find(a=>a.path==="package.json");if(i&&i.type==="file")try{const a=JSON.parse(i.content),l={...a,scripts:{start:"react-scripts start",build:"react-scripts build",test:"react-scripts test",eject:"react-scripts eject"},dependencies:{react:"^18.2.0","react-dom":"^18.2.0",clsx:((d=a.dependencies)==null?void 0:d.clsx)||"^2.1.0","tailwind-merge":((h=a.dependencies)==null?void 0:h["tailwind-merge"])||"^2.2.0","class-variance-authority":((u=a.dependencies)==null?void 0:u["class-variance-authority"])||"^0.7.0","lucide-react":((f=a.dependencies)==null?void 0:f["lucide-react"])||"^0.363.0","@iconify/react":((x=a.dependencies)==null?void 0:x["@iconify/react"])||"^6.0.2","@radix-ui/react-slot":((g=a.dependencies)==null?void 0:g["@radix-ui/react-slot"])||"^1.0.2","web-vitals":"^2.1.4"},devDependencies:{tailwindcss:"^3.4.1",autoprefixer:"^10.4.19",postcss:"^8.4.38"}};t.push({name:"package.json",type:"file",path:"package.json",content:JSON.stringify(l,null,2)})}catch{}const o=s.find(a=>a.path==="app/layout.tsx");if(o&&o.type==="file"){let a="React App",l="React App";const j=o.content.match(/title:\s*['"]([^'"]*)['"]/),y=o.content.match(/description:\s*['"]([^'"]*)['"]/);j&&(a=j[1]),y&&(l=y[1]),t.push({name:"index.html",type:"file",path:"public/index.html",content:`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="%PUBLIC_URL%/favicon.ico" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#000000" />
    <meta name="description" content="${l}" />
    <title>${a}</title>
  </head>
  <body>
    <noscript>You need to enable JavaScript to run this app.</noscript>
    <div id="root"></div>
  </body>
</html>`})}t.push({name:"index.tsx",type:"file",path:"src/index.tsx",content:`import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`});const c=s.find(a=>a.path==="app/page.tsx");if(c&&c.type==="file"){let a=c.content;a=a.replace(/['"]use client['"]/g,""),a=a.replace(/export default function Home\(\)/g,"function App()"),a=a.replace(/export default function Page\(\)/g,"function App()"),a.includes("export default App")||(a+=`

export default App;`),a=a.replace(/<main([^>]*)>/g,'<div className="App"$1>'),a=a.replace(/<\/main>/g,"</div>"),t.push({name:"App.tsx",type:"file",path:"src/App.tsx",content:a})}const e=s.find(a=>a.path==="app/globals.css");e&&e.type==="file"&&t.push({name:"index.css",type:"file",path:"src/index.css",content:e.content}),s.forEach(a=>{if(a.type==="file"&&a.path.startsWith("components/")){let l=a.content;l=l.replace(/['"]use client['"]/g,""),l=l.replace(/@\/components\/ui\//g,"./ui/"),l=l.replace(/@\/lib\//g,"../lib/"),t.push({...a,path:`src/${a.path}`})}}),s.forEach(a=>{a.type==="file"&&a.path.startsWith("lib/")&&t.push({...a,path:`src/${a.path}`})});const p=s.find(a=>a.path==="tailwind.config.ts");if(p){let a=p.content;a=a.replace(/'.\/(pages|components|app|lib)\/\*\*\/\*\.\{ts,tsx\}'/g,"'./src/**/*.{js,jsx,ts,tsx}'"),a=a.replace(/'.\/(pages|components|app|lib)\/\*\*\/\*\.\{ts,tsx\}',/g,`'./src/**/*.{js,jsx,ts,tsx}',
    './public/index.html',`),t.push({...p,content:a})}const n=s.find(a=>a.path==="postcss.config.js");return n&&t.push(n),t}function P(s){const r=m(s);let t;t=s,r==="vite-react"&&!t.some(e=>e.path==="vite.config.js"||e.path==="vite.config.ts")&&(t=[...t,{name:"vite.config.js",type:"file",path:"vite.config.js",content:`import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
})`,children:[]}]);const i={};function o(e){if(e.type==="file"){if(e.path==="/App.js"&&t.some(n=>n.path==="src/App.js"&&n.content.length>500)||e.path==="App.js"&&t.some(n=>n.path==="src/App.js"&&n.content.length>500)||e.path==="/index.js"&&t.some(n=>n.path==="src/index.js"&&n.content.length>200)||e.path==="index.js"&&t.some(n=>n.path==="src/index.js"&&n.content.length>200)||e.content.length<50&&e.path.includes("App")&&t.some(n=>n.path.includes("App")&&n.content.length>500&&n.path!==e.path))return;i[e.path]={code:e.content,readOnly:!1}}else e.type==="folder"&&e.children&&e.children.forEach(o)}t.forEach(o);const c=k(s);return i[c]||["src/App.jsx","src/App.js","src/App.tsx"].find(p=>i[p]),i}function N(s){const r=[],t=new Map;return Object.keys(s).forEach(i=>{const o=i.split("/");let c="";for(let e=0;e<o.length-1;e++){const p=o[e],n=c;if(c=c?`${c}/${p}`:p,!t.has(c)){const d={name:p,type:"folder",path:c,children:[],content:""};t.set(c,d),n&&t.has(n)?t.get(n).children.push(d):n||r.push(d)}}}),Object.entries(s).forEach(([i,o])=>{const c=i.split("/"),e=c[c.length-1],p=c.slice(0,-1).join("/"),n={name:e,type:"file",path:i,content:o.code||o,children:[]};p&&t.has(p)?t.get(p).children.push(n):r.push(n)}),r}function m(s){return s.map(t=>t.path),s.some(t=>t.path==="app/layout.tsx"||t.path==="next.config.js"||t.path==="pages/_app.js")?"nextjs":s.some(t=>t.path==="vite.config.js"||t.path==="vite.config.ts")?s.some(t=>t.path.includes(".vue"))?"vite-vue":s.some(t=>t.path.includes(".svelte"))?"vite-svelte":"vite-react":(s.some(t=>t.path==="src/index.js"||t.path==="src/App.js")||s.some(t=>t.path.endsWith(".jsx")||t.path.endsWith(".tsx")),"react")}function k(s){switch(m(s)){case"vite-react":const t=["src/App.jsx","src/App.tsx","src/main.jsx","src/main.tsx"];for(const p of t)if(s.some(n=>n.path===p))return p;return"src/App.jsx";case"vite-vue":const i=["src/App.vue","src/main.js","src/main.ts"];for(const p of i)if(s.some(n=>n.path===p))return p;return"src/App.vue";case"vite-svelte":const o=["src/App.svelte","src/main.js","src/main.ts"];for(const p of o)if(s.some(n=>n.path===p))return p;return"src/App.svelte";case"nextjs":const c=["app/page.tsx","app/page.js","pages/index.tsx","pages/index.js"];for(const p of c)if(s.some(n=>n.path===p))return p;return"app/page.tsx";default:const e=["src/App.js","src/App.jsx","src/App.tsx","src/index.js","src/index.tsx"];for(const p of e)if(s.some(n=>n.path===p))return p;return"src/App.js"}}function E(s){const r=m(s),t=[...s];if(r==="vite-react")return t;if(r==="nextjs"||r==="react"&&s.some(i=>i.path==="app/layout.tsx")){const i=s.some(p=>p.path==="package.json"),o=s.some(p=>p.path==="app/layout.tsx"||p.path==="app/layout.js"),c=s.some(p=>p.path==="app/page.tsx"||p.path==="app/page.js");s.some(p=>p.path==="tailwind.config.ts"||p.path==="tailwind.config.js");const e=s.some(p=>p.path==="app/globals.css");i||t.push({name:"package.json",type:"file",path:"package.json",content:JSON.stringify({name:"nextjs-app",version:"0.1.0",private:!0,scripts:{dev:"next dev",build:"next build",start:"next start",lint:"next lint"},dependencies:{next:"14.2.0",react:"18.2.0","react-dom":"18.2.0",tailwindcss:"^3.4.1"},devDependencies:{"@types/node":"^20","@types/react":"^18","@types/react-dom":"^18",typescript:"^5"}},null,2)}),o||t.push({name:"layout.tsx",type:"file",path:"app/layout.tsx",content:`import './globals.css';

export const metadata = {
  title: 'Next.js App',
  description: 'Generated by Aura React Generator',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}`}),c||t.push({name:"page.tsx",type:"file",path:"app/page.tsx",content:`export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold text-center text-gray-800 mb-8">
          Next.js App
        </h1>
        <p className="text-center text-gray-600">
          Your components will appear here.
        </p>
      </div>
    </main>
  );
}`}),e||t.push({name:"globals.css",type:"file",path:"app/globals.css",content:`@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}`})}else{const i=s.some(p=>p.path==="public/index.html"),o=s.some(p=>p.path==="package.json"),c=s.some(p=>p.path==="src/index.js"),e=s.some(p=>p.path==="src/App.js"||p.path==="src/App.jsx"||p.path==="src/App.tsx");i||t.push({name:"index.html",type:"file",path:"public/index.html",content:`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#000000" />
    <title>React App</title>
    <!-- Tailwind CSS loaded via Sandpack externalResources -->
  </head>
  <body>
    <noscript>You need to enable JavaScript to run this app.</noscript>
    <div id="root"></div>
  </body>
</html>`}),o||t.push({name:"package.json",type:"file",path:"package.json",content:JSON.stringify({name:"react-app",version:"0.1.0",private:!0,dependencies:{react:"^18.2.0","react-dom":"^18.2.0","web-vitals":"^2.1.4"},scripts:{start:"react-scripts start",build:"react-scripts build",test:"react-scripts test",eject:"react-scripts eject"}},null,2)}),c||t.push({name:"index.js",type:"file",path:"src/index.js",content:`import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`}),e||t.push({name:"App.js",type:"file",path:"src/App.js",content:`import React from 'react';
import './App.css';

function App() {
  return (
    <div className="App">
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
        <div className="container mx-auto px-4 py-8">
          <h1 className="text-3xl font-bold text-center text-gray-800 mb-8">
            React App
          </h1>
          <p className="text-center text-gray-600">
            Your React components will appear here.
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;`})}return t}function C(s){const r=s.find(t=>t.path==="package.json");if(!r||r.type!=="file")return{};try{const t=JSON.parse(r.content);return{...t.dependencies,...t.devDependencies}}catch(t){return console.error("Error parsing package.json for dependencies:",t),{}}}export{b as convertCRAToVite,S as convertFilesToFramework,w as convertNextJSToReactForPreview,N as convertSandpackToVirtualFiles,P as convertVirtualFilesToSandpack,v as convertViteToCRA,R as convertViteToReactForPreview,A as detectFramework,E as ensureBasicProjectStructure,C as getCustomDependencies,k as getMainFile,m as getSandpackTemplate};
