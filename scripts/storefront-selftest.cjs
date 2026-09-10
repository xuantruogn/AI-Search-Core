/* eslint-disable no-console */
// Requires Playwright + Chromium. Uses local HTTP fixtures intercepted by the
// browser; this is not a live Shopify compatibility certification.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const runtime = fs.readFileSync(path.join(__dirname,"../extensions/ai-search-storefront/assets/search-interceptor.v3.js"),"utf8");
const map = {version:3,theme:{id:"1"},fingerprint:"fp",search:{searchTemplate:"templates/search.json",searchSectionTypes:["search-results"],searchTemplateStructure:[{sectionIds:["main"]}]}};
const products=[{id:"2",handle:"beta"},{id:"1",handle:"alpha"}];
function grid(handles,variant) {
  const tag=variant==="blocks"?"product-card":"li";
  return `<ul id="product-grid" class="product-grid">${handles.map((handle)=>`<${tag} data-handle="${handle}"><a href="/products/${handle}"><img src="data:," alt="${handle}"><span>${handle}</span></a></${tag}>`).join("")}</ul>`;
}
function html(handles,{empty=false,variant="classic",themeId="1",designMode=false}={}) {
  return `<!doctype html><html><head><meta name="ai-search-theme-id" content="${themeId}"><script>window.AI_SEARCH_CONFIG=${JSON.stringify({theme_id:"1",designMode,search_endpoint:"/apps/ai-search",search_url:"/vi/search",defaultSearchTypes:["product"],unscopedSearchMode:"product_only",schema:map})};customElements.define("product-card",class extends HTMLElement { connectedCallback(){ this.dataset.connected="yes"; }});</script><script src="/runtime.js" defer></script></head><body><main><section id="shopify-section-template--123__main"><h1>Search</h1>${empty?"<p>No native results</p>":grid(handles,variant)}<nav class="pagination">Native pages</nav></section></main></body></html>`;
}
async function scenario(browser,options={}) {
  const page=await browser.newPage();
  const calls=[]; const nativePages=[]; const fallbacks=[]; const errors=[];
  page.on("pageerror",(error)=>errors.push(error.message));
  await page.route("https://theme.test/**",async(route)=>{
    const url=new URL(route.request().url());
    if(url.pathname==="/runtime.js") return route.fulfill({contentType:"application/javascript",body:runtime});
    if(url.pathname==="/apps/ai-search") {
      const mode=url.searchParams.get("mode")||"search";calls.push(mode);
      if(options.backendError && mode==="search") return route.fulfill({status:503,body:"Unavailable"});
      const data=mode==="theme-map"?{status:"success",theme_map:map}:{status:"success",theme_id:"1",map_fingerprint:"fp",products,target_ids:"id:2 OR id:1",pagination:{current_page:1,page_size:2,total_products:2,total_pages:1}};
      return route.fulfill({contentType:"application/json",body:JSON.stringify(data)});
    }
    const internal=(url.searchParams.get("q")||"").startsWith("id:");
    if(internal) {
      const n=Number(url.searchParams.get("page")||1);nativePages.push(n);
      return route.fulfill({contentType:"text/html",body:html(n===1?["alpha"]:options.missing?["alpha"]:["beta"],{variant:options.variant,themeId:options.changedTheme?"2":"1"})});
    }
    if(url.searchParams.has("_ai_search_bypass")) fallbacks.push(url.pathname+url.search);
    return route.fulfill({contentType:"text/html",body:html(["native-old"],options)});
  });
  await page.goto(`https://theme.test/vi/search?q=${encodeURIComponent(options.query||"green snowboard")}&type=${options.type||"product"}`);
  if(options.nativeOnly || options.designMode) {
    await page.waitForLoadState("networkidle");
    assert.deepEqual(calls,[]);
  } else if(options.backendError || options.missing || options.changedTheme) {
    await page.waitForFunction(()=>!location.search.includes("ai_search=1") && window.__aiSearchV3Installed);
    // Wait for fallback navigation, which the fixture records before response.
    await page.waitForURL((url)=>!url.searchParams.has("ai_search"));
    for(let i=0;i<20&&!fallbacks.length;i++) await page.waitForTimeout(50);
    assert.equal(fallbacks.length,1);
    assert.ok(fallbacks[0].startsWith("/vi/search?"));
    assert.equal(calls.filter((mode)=>mode==="search").length,1);
  } else {
    await page.waitForFunction(()=>Array.from(document.querySelectorAll("#product-grid > [data-handle]")).map((node)=>node.dataset.handle).join(",")==="beta,alpha");
    assert.deepEqual(await page.locator("#product-grid > [data-handle]").evaluateAll((nodes)=>nodes.map((node)=>node.dataset.handle)),["beta","alpha"]);
    assert.deepEqual(nativePages,[1,2]);
    assert.equal(calls.filter((mode)=>mode==="search").length,1);
    if(options.variant==="blocks") assert.equal(await page.locator('product-card[data-connected="yes"]').count(),2);
    assert.equal(await page.locator("#product-grid").evaluate((node)=>getComputedStyle(node).visibility),"visible");
  }
  assert.deepEqual(errors,[]);
  await page.close();
}
async function main() {
  const {chromium} = require("playwright");
  const browser=await chromium.launch({headless:true});
  try {
    for(const options of [{},{empty:true},{variant:"blocks"},{missing:true},{changedTheme:true},{backendError:true},{query:"SKU123",nativeOnly:true},{type:"product,page",nativeOnly:true},{designMode:true}]) await scenario(browser,options);
    console.log("Storefront native HTML / ranking / fallback browser fixtures: PASS (9 scenarios)");
  } finally {await browser.close();}
}
module.exports={html,map,products,runtime};
if(require.main===module) main().catch((error)=>{console.error(error);process.exitCode=1;});
