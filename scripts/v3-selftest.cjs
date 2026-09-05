/* eslint-disable no-console */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-search-v3-"));

function write(relativePath, content) {
  const target = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function transpile(sourcePath, targetPath) {
  const source = fs.readFileSync(path.join(projectRoot, sourcePath), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
  write(targetPath, output);
}

function fixtureFiles(snippet, updatedAt) {
  const files = [
    {
      filename: "sections/search-grid.liquid",
      content: `<ul class="grid product-grid">{% for x in search.results %}<li class="grid__item">{% render '${snippet}', merchandise: x, show_vendor: section.settings.show_vendor %}</li>{% endfor %}</ul>`,
    },
    {
      filename: `snippets/${snippet}.liquid`,
      content: `<a href="{{ merchandise.url }}"><span>{{ merchandise.title }}</span>{{ merchandise.featured_image | image_url: width: 300 | image_tag }}</a>`,
    },
    {
      filename: "templates/search.json",
      content: JSON.stringify({
        sections: { main: { type: "search-grid", settings: { show_vendor: true } } },
        order: ["main"],
      }),
    },
    {
      filename: "config/settings_data.json",
      content: JSON.stringify({ current: {} }),
    },
  ];

  return files.map((file) => ({
    ...file,
    checksumMd5: crypto.createHash("md5").update(file.content).digest("hex"),
    updatedAt,
  }));
}

function makeAdmin(state, counters = { active: 0, files: 0 }) {
  return {
    counters,
    async graphql(query) {
      if (query.includes("GetActiveThemeIdentity")) {
        counters.active += 1;
        const theme = state.theme;
        return new Response(
          JSON.stringify({
            data: {
              themes: {
                nodes: [
                  {
                    id: theme.id,
                    name: theme.name,
                    updatedAt: theme.updatedAt,
                    processing: Boolean(theme.processing),
                    processingFailed: Boolean(theme.processingFailed),
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (query.includes("DiscoverThemeFiles")) {
        counters.files += 1;
        // Capture the source snapshot before an optional gate so lifecycle
        // tests can model a publish/update racing an in-flight discovery.
        const files = state.files.map((file) => ({
          filename: file.filename,
          checksumMd5: file.checksumMd5,
          updatedAt: file.updatedAt,
          body: { content: file.content },
        }));
        if (typeof state.beforeFilesResponse === "function") {
          await state.beforeFilesResponse(counters.files);
        }
        return new Response(
          JSON.stringify({
            data: {
              theme: {
                files: {
                  nodes: files,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  userErrors: [],
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`Unexpected GraphQL query: ${query.slice(0, 80)}`);
    },
  };
}

function setupProxyRuntime() {
  transpile("app/routes/proxy.ai-search.ts", "routes/proxy.ai-search.js");

  write(
    "proxy-state.js",
    `module.exports = new Proxy({}, { get(_target, key) { return global.__aiSearchV3ProxyState[key]; }, set(_target, key, value) { global.__aiSearchV3ProxyState[key] = value; return true; } });`,
  );
  write(
    "shopify.server.js",
    `const s=require('./proxy-state'); module.exports={authenticate:{public:{appProxy:async()=>({admin:{},session:{shop:'test.myshopify.com'},liquid:async()=>{s.order.push('liquid'); return new Response('<html>ok</html>',{status:200})}})}}};`,
  );
  write(
    "services/theme/theme-renderer-profile.server.js",
    `const s=require('../../proxy-state'); module.exports={getCompiledThemeRenderer:async()=>{s.order.push('theme');s.theme+=1;if(s.themeError)throw new Error('unsupported theme');return {rendererId:'r1',themeId:s.rendererThemeId||'t1',themeName:'Theme',themeUpdatedAt:s.rendererThemeUpdatedAt||'2026-09-04T00:00:00Z',themeVersionKey:s.rendererThemeVersionKey||'t1\\0'+'2026-09-04T00:00:00Z',themeFingerprint:'fp',sourceFile:'sections/x.liquid',templateFile:'templates/search.json',sectionType:'x',profile:{cardSnippet:'card',productArgument:'product',implicitProductVariable:null,invocationTag:'render',renderArguments:{},stylesheetAssets:[],gridClass:null,itemClass:null,containerClass:null,gridTag:'div',itemTag:'div',containerTag:'div',score:1,signals:['search-context']},resolvedArguments:{},score:1}},rejectThemeRendererCandidate:()=>{s.rejected+=1}};`,
  );
  write(
    "services/renderer/renderer-bridge.server.js",
    `module.exports={buildThemeSearchLiquid:()=>'<div>cards</div>'};`,
  );
  write(
    "services/search/semantic-search.server.js",
    `const s=require('../../proxy-state'); module.exports={semanticSearch:async({onEmbeddingCreated})=>{s.order.push('semantic');s.semantic+=1;if(onEmbeddingCreated)await onEmbeddingCreated();if(s.semanticError)throw new Error('semantic failed');return [{productId:'gid://shopify/Product/1',handle:'alpha',title:'Alpha',score:0.9}]}};`,
  );
  write(
    "services/search/search-result-revalidation.server.js",
    `const s=require('../../proxy-state'); module.exports={revalidateSearchResults:async({results,limit})=>{s.order.push('revalidate');s.revalidate+=1;if(s.revalidateError)throw new Error('revalidation failed');return {results:s.revalidateEmpty?[]:results.slice(0,limit),staleProductIds:s.revalidateEmpty?results.map(x=>x.productId):[],repairedMetadata:0}}};`,
  );
  write(
    "services/theme/theme-reader.server.js",
    `const s=require('../../proxy-state'); module.exports={getActiveTheme:async()=>{s.order.push('active-theme');const themes=s.activeThemeSequence||[{id:'t1',name:'Theme',updatedAt:'2026-09-04T00:00:00Z'}];const theme=themes[Math.min(s.activeTheme,themes.length-1)];s.activeTheme+=1;return {...theme,processing:Boolean(theme.processing),processingFailed:Boolean(theme.processingFailed),versionKey:theme.versionKey||theme.id+'\\0'+theme.updatedAt}}};`,
  );
  write(
    "services/theme/app-embed.server.js",
    `const s=require('../../proxy-state'); module.exports={getAiSearchAppEmbedStatusForTheme:async()=>{s.order.push('app-embed');s.appEmbed+=1;return {enabled:s.embedEnabled,themeId:'t1',themeUpdatedAt:'2026-09-04T00:00:00Z',themeName:'Theme',reason:s.embedEnabled?'ENABLED':'DISABLED'}}};`,
  );
  transpile(
    "app/services/search/search-request-router.server.ts",
    "services/search/search-request-router.server.js",
  );
  write(
    "services/commerce/entitlement.server.js",
    `const s=require('../../proxy-state'); module.exports={getShopEntitlement:async()=>{s.order.push('entitlement');s.entitlement+=1;return s.entitlementValue}};`,
  );
  write(
    "services/commerce/reconciliation.server.js",
    `module.exports={reconcileShopCommercialState:async()=>({})};`,
  );
  write(
    "services/billing/shopify-app-pricing.server.js",
    `module.exports={refreshShopifyAppPricingIfStale:async()=>({changed:false})};`,
  );
  write(
    "services/commerce/usage.server.js",
    `const s=require('../../proxy-state'); module.exports={reserveSearchUsage:async()=>{s.order.push('reserve');s.reserve+=1;return s.reserveAllowed?{allowed:true,reservation:{id:'u1'}}:{allowed:false}},commitSearchUsage:async()=>{s.commit+=1},markUsageReservationEffectApplied:async()=>{},recordFallback:async()=>{s.fallback+=1},recordQueryEmbeddingConsumed:async()=>{s.embedding+=1},rollbackSearchUsage:async()=>{s.rollback+=1}};`,
  );

  // The lifecycle tests load the real transpiled theme modules first. Clear
  // those CommonJS cache entries after replacing them with proxy stubs so the
  // route integration test cannot accidentally execute the old module.
  for (const relativePath of [
    "shopify.server.js",
    "services/theme/theme-renderer-profile.server.js",
    "services/renderer/renderer-bridge.server.js",
    "services/search/semantic-search.server.js",
    "services/search/search-result-revalidation.server.js",
    "services/search/search-request-router.server.js",
    "services/theme/theme-reader.server.js",
    "services/theme/app-embed.server.js",
    "services/commerce/entitlement.server.js",
    "services/commerce/reconciliation.server.js",
    "services/billing/shopify-app-pricing.server.js",
    "services/commerce/usage.server.js",
  ]) {
    const absolutePath = path.join(tempRoot, relativePath);
    try {
      delete require.cache[require.resolve(absolutePath)];
    } catch {}
  }
}

function newProxyState(overrides = {}) {
  return {
    order: [],
    theme: 0,
    semantic: 0,
    revalidate: 0,
    activeTheme: 0,
    appEmbed: 0,
    entitlement: 0,
    reserve: 0,
    embedding: 0,
    fallback: 0,
    commit: 0,
    rollback: 0,
    rejected: 0,
    themeError: false,
    semanticError: false,
    revalidateError: false,
    revalidateEmpty: false,
    reserveAllowed: true,
    embedEnabled: true,
    activeThemeSequence: null,
    rendererThemeId: null,
    rendererThemeUpdatedAt: null,
    rendererThemeVersionKey: null,
    entitlementValue: {
      searchAllowed: true,
      disabledReason: null,
      indexedProducts: 10,
      resultLimit: 20,
      limits: { searchLimit: 3000 },
      usage: { id: 1 },
    },
    ...overrides,
  };
}

async function proxyScenario(query, nativeTarget, stateOverrides = {}) {
  global.__aiSearchV3ProxyState = newProxyState(stateOverrides);
  const modulePath = path.join(tempRoot, "routes/proxy.ai-search.js");
  delete require.cache[require.resolve(modulePath)];
  const { loader } = require(modulePath);
  const url = new URL("https://shop.test/apps/ai-search");
  url.searchParams.set("q", query);
  url.searchParams.set("native_search_url", nativeTarget);
  const response = await loader({ request: new Request(url), params: {}, context: {} });
  return { response, state: global.__aiSearchV3ProxyState };
}

async function main() {
  // Pure pre-AI request routing.
  transpile(
    "app/services/search/search-request-router.server.ts",
    "services/search/search-request-router.server.js",
  );
  const router = require(path.join(
    tempRoot,
    "services/search/search-request-router.server.js",
  ));
  const decide = (query, target) =>
    router.classifySearchRequest({
      query,
      nativeSearchTarget: target,
      maxQueryChars: 500,
      minSemanticQueryChars: 3,
    });

  assert.equal(decide("green", "/search?q=green&type=product").engine, "AI");
  assert.equal(decide("12312", "/search?q=12312&type=product").reason, "EXACT_IDENTIFIER_QUERY");
  assert.equal(decide("ABC-123", "/search?q=ABC-123&type=product").reason, "EXACT_IDENTIFIER_QUERY");
  assert.equal(decide("green", "/search?q=green&type=product,page").reason, "SEARCH_TYPES_NOT_PRODUCT_ONLY");
  assert.ok(decide("green", "/search?q=green&type=product&filter.v.option.color=red").reason.startsWith("UNSUPPORTED_SEARCH_PARAM"));
  assert.equal(decide("green", "/search?q=green&type=product&sort_by=price-ascending").reason, "NON_RELEVANCE_SORT");
  assert.equal(decide("green", "/search?q=green&type=product&page=2").reason, "PAGINATED_SEARCH");

  // Storefront data visibility: scheduled/unpublished products must never be
  // treated as searchable just because publishedAt is non-null.
  transpile(
    "app/services/products/product-visibility.server.ts",
    "services/products/product-visibility.server.js",
  );
  const productVisibility = require(path.join(
    tempRoot,
    "services/products/product-visibility.server.js",
  ));
  const now = Date.parse("2026-09-04T12:00:00Z");
  assert.equal(productVisibility.isSearchableOnlineStoreProduct({status:"ACTIVE",publishedAt:"2026-09-04T11:00:00Z",nowMs:now}), true);
  assert.equal(productVisibility.isSearchableOnlineStoreProduct({status:"ACTIVE",publishedAt:"2026-09-04T13:00:00Z",nowMs:now}), false);
  assert.equal(productVisibility.isSearchableOnlineStoreProduct({status:"DRAFT",publishedAt:"2026-09-04T11:00:00Z",nowMs:now}), false);
  assert.equal(productVisibility.isSearchableOnlineStoreProduct({status:"ACTIVE",publishedAt:null,nowMs:now}), false);

  // Exercise the real Admin GraphQL mapping paths as well as the pure
  // predicate. This catches a future query edit that accidentally drops
  // status/publishedAt or stops applying the safety fence.
  transpile(
    "app/services/products/product-sync.server.ts",
    "services/products/product-sync.server.js",
  );
  const productSync = require(path.join(
    tempRoot,
    "services/products/product-sync.server.js",
  ));
  const productNode = (id, status, publishedAt) => ({
    id,
    handle: `handle-${id}`,
    title: `Title ${id}`,
    description: "Description",
    vendor: "Vendor",
    productType: "Type",
    tags: [],
    status,
    publishedAt,
    variants: { nodes: [{ title: "Default", sku: null }] },
  });
  const visibilityNodes = [
    productNode("p-live", "ACTIVE", "2020-01-01T00:00:00Z"),
    productNode("p-scheduled", "ACTIVE", "2999-01-01T00:00:00Z"),
    productNode("p-draft", "DRAFT", "2020-01-01T00:00:00Z"),
    productNode("p-unpublished", "ACTIVE", null),
  ];
  let fullCatalogQuery = "";
  const catalogAdmin = {
    async graphql(query) {
      fullCatalogQuery = query;
      return new Response(JSON.stringify({
        data: {
          products: {
            nodes: visibilityNodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const visiblePage = await productSync.fetchProductsForIndex(catalogAdmin);
  assert.ok(fullCatalogQuery.includes("published_status:published"));
  assert.ok(fullCatalogQuery.includes("publishedAt"));
  assert.deepEqual(visiblePage.products.map((product) => product.id), ["p-live"]);

  const nodesAdmin = {
    async graphql() {
      return new Response(JSON.stringify({ data: { nodes: visibilityNodes } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  const visibleSnapshots =
    await productSync.fetchSearchableProductSnapshotsByIds(
      nodesAdmin,
      visibilityNodes.map((product) => product.id),
    );
  assert.deepEqual([...visibleSnapshots.keys()], ["p-live"]);

  const scheduledAdmin = {
    async graphql() {
      return new Response(JSON.stringify({
        data: { product: visibilityNodes[1] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  assert.equal(
    await productSync.fetchProductForIndexById(scheduledAdmin, "p-scheduled"),
    null,
  );

  // Compiler + renderer arbitrary variable/product argument.
  transpile(
    "app/services/theme/theme-compiler.server.ts",
    "services/theme/theme-compiler.server.js",
  );
  transpile(
    "app/services/renderer/renderer-bridge.server.ts",
    "services/renderer/renderer-bridge.server.js",
  );
  const compiler = require(path.join(tempRoot, "services/theme/theme-compiler.server.js"));
  const bridge = require(path.join(tempRoot, "services/renderer/renderer-bridge.server.js"));
  const source = `<ul class="grid product-grid">{% for x in search.results %}<li class="grid__item">{% render 'tile', merchandise: x %}</li>{% endfor %}</ul>`;
  const candidates = compiler.compileSearchRendererCandidates(source);
  assert.ok(candidates.length > 0);
  assert.equal(candidates[0].profile.productArgument, "merchandise");
  const rendered = bridge.buildThemeSearchLiquid({
    handles: ["alpha"],
    profile: candidates[0].profile,
    resolvedArguments: {},
  });
  assert.ok(rendered.includes("merchandise: ai_product"));

  // Hard context must not be treated as a safe standalone card.
  const hard = compiler.analyzeSnippetCompatibility(`{% doc %}@param {product} product{% enddoc %}<a href="{{ product.url }}">{{ product.title }}</a>{% content_for 'block', type: 'x', id: 'x' %}`);
  assert.ok(hard.hardContextDependencies.includes("theme-block-context"));

  // Theme lifecycle: A -> B, same-ID source edit, then concurrent discovery.
  transpile("app/services/theme/theme-reader.server.ts", "services/theme/theme-reader.server.js");
  transpile("app/services/theme/theme-settings-resolver.server.ts", "services/theme/theme-settings-resolver.server.js");
  transpile("app/services/theme/theme-renderer-profile.server.ts", "services/theme/theme-renderer-profile.server.js");
  const profile = require(path.join(tempRoot, "services/theme/theme-renderer-profile.server.js"));
  const state = {
    theme: { id: "gid://theme/A", name: "A", updatedAt: "2026-09-04T01:00:00Z" },
    files: fixtureFiles("tile-a", "2026-09-04T01:00:00Z"),
  };
  const admin = makeAdmin(state);
  const a = await profile.getCompiledThemeRenderer({ admin, shop: "switch-test.myshopify.com" });
  assert.equal(a.profile.cardSnippet, "tile-a");

  state.theme = { id: "gid://theme/B", name: "B", updatedAt: "2026-09-04T02:00:00Z" };
  state.files = fixtureFiles("tile-b", "2026-09-04T02:00:00Z");
  const b = await profile.getCompiledThemeRenderer({ admin, shop: "switch-test.myshopify.com" });
  assert.equal(b.profile.cardSnippet, "tile-b");

  state.theme = { id: "gid://theme/B", name: "B", updatedAt: "2026-09-04T03:00:00Z" };
  state.files = fixtureFiles("tile-c", "2026-09-04T03:00:00Z");
  const c = await profile.getCompiledThemeRenderer({ admin, shop: "switch-test.myshopify.com" });
  assert.equal(c.profile.cardSnippet, "tile-c");
  assert.notEqual(c.themeVersionKey, b.themeVersionKey);

  // A renderer rejected on one theme version must be reconsidered on a new version.
  profile.rejectThemeRendererCandidate({
    shop: "reject-test.myshopify.com",
    themeVersionKey: a.themeVersionKey,
    rendererId: a.rendererId,
  });
  const rejectState = {
    theme: { id: "gid://theme/A", name: "A", updatedAt: "2026-09-04T05:00:00Z" },
    files: fixtureFiles("tile-a", "2026-09-04T05:00:00Z"),
  };
  const freshA = await profile.getCompiledThemeRenderer({ admin: makeAdmin(rejectState), shop: "reject-test.myshopify.com" });
  assert.equal(freshA.profile.cardSnippet, "tile-a");

  const concurrentState = {
    theme: { id: "gid://theme/C", name: "C", updatedAt: "2026-09-04T04:00:00Z" },
    files: fixtureFiles("tile-con", "2026-09-04T04:00:00Z"),
  };
  const counters = { active: 0, files: 0 };
  const concurrentAdmin = makeAdmin(concurrentState, counters);
  await Promise.all(Array.from({ length: 5 }, () => profile.getCompiledThemeRenderer({ admin: concurrentAdmin, shop: "concurrent-test.myshopify.com" })));
  assert.equal(counters.files, 1);

  // A themes/update invalidation can arrive while source discovery is in
  // flight, including before Shopify exposes a new updatedAt. The obsolete
  // build must neither repopulate cache nor be returned to the waiting search.
  let signalFirstDiscovery;
  let releaseFirstDiscovery;
  const firstDiscoveryStarted = new Promise((resolve) => {
    signalFirstDiscovery = resolve;
  });
  const firstDiscoveryGate = new Promise((resolve) => {
    releaseFirstDiscovery = resolve;
  });
  const raceState = {
    theme: { id: "gid://theme/R", name: "R", updatedAt: "2026-09-04T07:00:00Z" },
    files: fixtureFiles("tile-old", "2026-09-04T07:00:00Z"),
    beforeFilesResponse: async (call) => {
      if (call === 1) {
        signalFirstDiscovery();
        await firstDiscoveryGate;
      }
    },
  };
  const raceCounters = { active: 0, files: 0 };
  const raceAdmin = makeAdmin(raceState, raceCounters);
  const firstRaceBuild = profile.getCompiledThemeRenderer({
    admin: raceAdmin,
    shop: "race-test.myshopify.com",
  });
  await firstDiscoveryStarted;
  raceState.files = fixtureFiles("tile-new", "2026-09-04T07:00:00Z");
  profile.invalidateThemeRendererCache("race-test.myshopify.com");
  const secondRaceBuild = profile.getCompiledThemeRenderer({
    admin: raceAdmin,
    shop: "race-test.myshopify.com",
  });
  const secondRaceResult = await secondRaceBuild;
  releaseFirstDiscovery();
  const firstRaceResult = await firstRaceBuild;
  assert.equal(secondRaceResult.profile.cardSnippet, "tile-new");
  assert.equal(firstRaceResult.profile.cardSnippet, "tile-new");
  assert.equal(raceCounters.files, 2);

  // Invalidation also clears runtime-rejected candidates. Editing/publishing
  // the same version must not leave the integration poisoned until TTL expiry.
  profile.rejectThemeRendererCandidate({
    shop: "race-test.myshopify.com",
    themeVersionKey: secondRaceResult.themeVersionKey,
    rendererId: secondRaceResult.rendererId,
  });
  profile.invalidateThemeRendererCache("race-test.myshopify.com");
  const afterInvalidation = await profile.getCompiledThemeRenderer({
    admin: raceAdmin,
    shop: "race-test.myshopify.com",
  });
  assert.equal(afterInvalidation.profile.cardSnippet, "tile-new");

  // Theme processing must fail preflight rather than reaching AI.
  const processingState = {
    theme: { id: "gid://theme/P", name: "P", updatedAt: "2026-09-04T06:00:00Z", processing: true },
    files: fixtureFiles("tile-p", "2026-09-04T06:00:00Z"),
  };
  await assert.rejects(() => profile.getCompiledThemeRenderer({ admin: makeAdmin(processingState), shop: "processing-test.myshopify.com" }));

  // Search-result data revalidation: Shopify is source of truth. Stale products
  // are removed, changed handle/title metadata is repaired, and search-time
  // liveness does not pretend to be a full catalog scan.
  global.__aiSearchV3RevalidationState = {
    payloadUpdates: [],
    deleted: [],
    removed: [],
    liveSeen: [],
  };
  write(
    "services/search/vector-store.server.js",
    `const s=global.__aiSearchV3RevalidationState; module.exports={updateProductVectorPayloadForShop:async(x)=>{s.payloadUpdates.push(x)},deleteProductVectorForShop:async(x)=>{s.deleted.push(x.productId)}};`,
  );
  write(
    "services/products/product-sync.server.js",
    `module.exports={fetchSearchableProductSnapshotsByIds:async()=>new Map([['p1',{productId:'p1',handle:'new-handle',title:'New title'}]])};`,
  );
  write(
    "services/commerce/indexed-products.server.js",
    `const s=global.__aiSearchV3RevalidationState; module.exports={removeIndexedProduct:async(_shop,id)=>{s.removed.push(id)},touchIndexedProductLiveSeen:async(x)=>{s.liveSeen.push(x)}};`,
  );
  transpile(
    "app/services/search/search-result-revalidation.server.ts",
    "services/search/search-result-revalidation.server.js",
  );
  // product-sync was loaded above for the real publishedAt tests. Clear every
  // dependency replaced by this isolated revalidation harness, otherwise
  // CommonJS can retain the real module and bypass the mocks.
  for (const relativePath of [
    "services/search/vector-store.server.js",
    "services/products/product-sync.server.js",
    "services/commerce/indexed-products.server.js",
    "services/search/search-result-revalidation.server.js",
  ]) {
    const absolutePath = path.join(tempRoot, relativePath);
    try {
      delete require.cache[require.resolve(absolutePath)];
    } catch {}
  }
  const revalidation = require(path.join(
    tempRoot,
    "services/search/search-result-revalidation.server.js",
  ));
  const revalidated = await revalidation.revalidateSearchResults({
    admin: {},
    shop: "data-test.myshopify.com",
    limit: 20,
    results: [
      {productId:'p1',handle:'old-handle',title:'Old title',score:0.9},
      {productId:'p2',handle:'stale',title:'Stale',score:0.8},
    ],
  });
  assert.equal(revalidated.results.length, 1);
  assert.equal(revalidated.results[0].handle, 'new-handle');
  assert.deepEqual(revalidated.staleProductIds, ['p2']);
  assert.equal(global.__aiSearchV3RevalidationState.payloadUpdates.length, 1);
  assert.deepEqual(global.__aiSearchV3RevalidationState.deleted, ['p2']);
  assert.deepEqual(global.__aiSearchV3RevalidationState.removed, ['p2']);
  assert.equal(global.__aiSearchV3RevalidationState.liveSeen.length, 1);

  // Full proxy ordering with stubs: native decisions and unsupported themes
  // must consume zero embeddings/reservations.
  setupProxyRuntime();
  let scenario = await proxyScenario("12312", "/search?q=12312&type=product");
  assert.equal(scenario.response.status, 302);
  assert.equal(scenario.state.entitlement, 0);
  assert.equal(scenario.state.theme, 0);
  assert.equal(scenario.state.reserve, 0);
  assert.equal(scenario.state.semantic, 0);
  assert.equal(scenario.state.embedding, 0);

  scenario = await proxyScenario("green", "/search?q=green&type=product,page");
  assert.equal(scenario.state.theme, 0);
  assert.equal(scenario.state.semantic, 0);

  scenario = await proxyScenario("green", "/search?q=green&type=product", { themeError: true });
  assert.equal(scenario.response.status, 302);
  assert.equal(scenario.state.theme, 1);
  assert.equal(scenario.state.reserve, 0);
  assert.equal(scenario.state.semantic, 0);
  assert.equal(scenario.state.embedding, 0);

  scenario = await proxyScenario("green", "/search?q=green&type=product", { embedEnabled: false });
  assert.equal(scenario.response.status, 302);
  assert.equal(scenario.state.activeTheme, 1);
  assert.equal(scenario.state.appEmbed, 1);
  assert.equal(scenario.state.theme, 0);
  assert.equal(scenario.state.reserve, 0);
  assert.equal(scenario.state.semantic, 0);
  assert.equal(scenario.state.embedding, 0);

  scenario = await proxyScenario("green", "/search?q=green&type=product", {
    activeThemeSequence: [
      {id:"t1",name:"Theme A",updatedAt:"2026-09-04T00:00:00Z"},
      {id:"t2",name:"Theme B",updatedAt:"2026-09-04T00:01:00Z"},
    ],
  });
  assert.equal(scenario.response.status, 302);
  assert.equal(scenario.state.activeTheme, 2);
  assert.equal(scenario.state.theme, 0);
  assert.equal(scenario.state.reserve, 0);
  assert.equal(scenario.state.semantic, 0);
  assert.equal(scenario.state.embedding, 0);

  scenario = await proxyScenario("green", "/search?q=green&type=product", {
    rendererThemeId: "t2",
    rendererThemeUpdatedAt: "2026-09-04T00:01:00Z",
    rendererThemeVersionKey: "t2\0v2",
  });
  assert.equal(scenario.response.status, 302);
  assert.equal(scenario.state.theme, 1);
  assert.equal(scenario.state.reserve, 0);
  assert.equal(scenario.state.semantic, 0);
  assert.equal(scenario.state.embedding, 0);

  scenario = await proxyScenario("green", "/search?q=green&type=product", {
    entitlementValue: {
      searchAllowed: false,
      disabledReason: "SEARCH_QUOTA_EXCEEDED",
      indexedProducts: 10,
      resultLimit: 20,
      limits: { searchLimit: 3000 },
      usage: { id: 1 },
    },
  });
  assert.equal(scenario.state.theme, 0);
  assert.equal(scenario.state.reserve, 0);
  assert.equal(scenario.state.semantic, 0);

  scenario = await proxyScenario("green snowboard", "/search?q=green+snowboard&type=product");
  assert.equal(scenario.response.status, 200);
  assert.deepEqual(scenario.state.order.slice(0, 9), ["entitlement", "active-theme", "app-embed", "active-theme", "theme", "reserve", "semantic", "revalidate", "liquid"]);
  assert.equal(scenario.state.theme, 1);
  assert.equal(scenario.state.reserve, 1);
  assert.equal(scenario.state.semantic, 1);
  assert.equal(scenario.state.revalidate, 1);
  assert.equal(scenario.state.embedding, 1);
  assert.equal(scenario.state.commit, 1);

  // The proxy harness deliberately mocks the new revalidation module. If all
  // vector candidates are no longer storefront-visible, usage is rolled back
  // and native search is used without attempting Liquid.
  scenario = await proxyScenario("green snowboard", "/search?q=green+snowboard&type=product", {
    revalidateEmpty: true,
  });
  assert.equal(scenario.response.status, 302);
  assert.equal(scenario.state.semantic, 1);
  assert.equal(scenario.state.revalidate, 1);
  assert.equal(scenario.state.embedding, 1);
  assert.equal(scenario.state.rollback, 1);
  assert.equal(scenario.state.commit, 0);
  assert.equal(scenario.state.order.includes("liquid"), false);

  console.log("AI Search Bridge V3 self-test: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
