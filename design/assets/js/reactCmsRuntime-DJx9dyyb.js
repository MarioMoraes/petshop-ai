const i="src/lib/auraCms.js",a="AURA_CMS_COLLECTION_REQUEST",l="AURA_CMS_COLLECTION_RESPONSE",c=({})=>`import { useEffect, useState } from "react";

const AURA_CMS_COLLECTION_REQUEST_TYPE = ${JSON.stringify(a)};
const AURA_CMS_COLLECTION_RESPONSE_TYPE = ${JSON.stringify(l)};
const AURA_CMS_REQUEST_TIMEOUT_MS = 15000;
const PLACEHOLDER_CMS_IMAGE_HOST_PATTERN = /https?:\\/\\/images\\.example\\.com\\//i;
const cmsCollectionCache = new Map();
const cmsCollectionInflightRequests = new Map();

const isPlaceholderCmsImageUrl = (value) =>
  typeof value === "string" && PLACEHOLDER_CMS_IMAGE_HOST_PATTERN.test(value);

const buildFallbackCmsImageUrl = (key, itemData = {}) => {
  const identity =
    itemData.slug ||
    itemData.name ||
    itemData.title ||
    itemData.label ||
    itemData.id ||
    "cms-item";

  if (/(avatar|headshot|profile|photo)/i.test(key)) {
    return \`https://i.pravatar.cc/240?u=\${encodeURIComponent(String(identity))}\`;
  }

  const label =
    itemData.title || itemData.name || itemData.label || itemData.slug || "Image";

  return \`https://placehold.co/600x400/0f172a/ffffff?text=\${encodeURIComponent(
    String(label),
  )}\`;
};

const normalizeCollectionItems = (items) =>
  (items || []).map((item) => {
    const sourceData = item.data || {};
    const normalizedData = Object.fromEntries(
      Object.entries(sourceData).map(([key, value]) => [
        key,
        isPlaceholderCmsImageUrl(value)
          ? buildFallbackCmsImageUrl(key, {
              ...sourceData,
              id: item.id,
            })
          : value,
      ]),
    );

    return {
      id: item.id,
      isPublished: item.is_published !== false,
      ...normalizedData,
    };
  });

const requestAuraCMSCollection = (collectionSlug, options = {}) => {
  if (typeof window === "undefined") {
    return Promise.resolve([]);
  }

  if (!window.parent || window.parent === window) {
    return Promise.reject(
      new Error("Aura CMS is only available inside the Aura preview runtime."),
    );
  }

  const requestId = \`aura-cms-\${Date.now().toString(36)}-\${Math.random()
    .toString(36)
    .slice(2, 10)}\`;

  return new Promise((resolve, reject) => {
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener("message", handleMessage);
    };

    const handleMessage = (event) => {
      if (event.source !== window.parent) {
        return;
      }

      const message = event.data;
      if (
        !message ||
        message.type !== AURA_CMS_COLLECTION_RESPONSE_TYPE ||
        message.requestId !== requestId
      ) {
        return;
      }

      cleanup();

      if (message.error) {
        reject(new Error(message.error));
        return;
      }

      resolve(Array.isArray(message.items) ? message.items : []);
    };

    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Aura CMS bridge timed out."));
    }, AURA_CMS_REQUEST_TIMEOUT_MS);

    window.addEventListener("message", handleMessage);
    window.parent.postMessage(
      {
        type: AURA_CMS_COLLECTION_REQUEST_TYPE,
        requestId,
        collectionSlug,
        publishedOnly: options.publishedOnly === true,
      },
      "*",
    );
  });
};

export const fetchAuraCMSCollection = async (collectionSlug, options = {}) => {
  const cacheKey = \`\${String(collectionSlug || "").trim().toLowerCase()}::\${options.publishedOnly === true ? "published" : "draft"}\`;

  if (cmsCollectionCache.has(cacheKey)) {
    return cmsCollectionCache.get(cacheKey);
  }

  if (cmsCollectionInflightRequests.has(cacheKey)) {
    return cmsCollectionInflightRequests.get(cacheKey);
  }

  const request = requestAuraCMSCollection(collectionSlug, options)
    .then((items) => normalizeCollectionItems(items))
    .then((items) => {
      cmsCollectionCache.set(cacheKey, items);
      return items;
    })
    .finally(() => {
      cmsCollectionInflightRequests.delete(cacheKey);
    });

  cmsCollectionInflightRequests.set(cacheKey, request);
  return request;
};

export const useAuraCMSCollection = (collectionSlug, options = {}) => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let isActive = true;

    const loadCollection = async () => {
      setLoading(true);
      setError(null);

      try {
        const nextItems = await fetchAuraCMSCollection(collectionSlug, options);
        if (!isActive) {
          return;
        }

        setItems(nextItems);
      } catch (loadError) {
        if (!isActive) {
          return;
        }

        setItems([]);
        setError(loadError instanceof Error ? loadError : new Error("Failed to load CMS collection."));
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    loadCollection();

    return () => {
      isActive = false;
    };
  }, [collectionSlug, options.publishedOnly]);

  const featuredItems = items.filter((item) => item?.featured);

  return {
    items,
    featuredItems,
    loading,
    error,
  };
};
`,u=({files:e,cmsProjectId:r})=>{const s=e.findIndex(t=>t.type==="file"&&t.path===i);if(!r&&s<0)return{files:e,changed:!1};const n=c({});if(s>=0){const t=e[s];if(t.content===n)return{files:e,changed:!1};const o=[...e];return o[s]={...t,content:n},{files:o,changed:!0}}return{files:[...e,{name:"auraCms.js",path:i,content:n,type:"file"}],changed:!0}};export{a as AURA_CMS_COLLECTION_REQUEST_TYPE,l as AURA_CMS_COLLECTION_RESPONSE_TYPE,i as REACT_CMS_RUNTIME_FILE_PATH,c as buildReactCmsRuntimeFileContent,u as ensureReactCmsRuntimeFile};
