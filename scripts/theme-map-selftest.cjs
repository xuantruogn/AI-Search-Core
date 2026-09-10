/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-theme-map-"));
for (const name of ["theme-map.server", "theme-map-storage.server", "theme/theme-source-graph.server", "theme/theme-map-lifecycle.server", "theme/theme-reader.server", "theme/theme-json.server", "theme/app-embed.server"]) {
  const target = path.join(temp, `${name}.js`);
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, ts.transpileModule(fs.readFileSync(path.join(root, "app/services", `${name}.ts`), "utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
}
const lifecycle = require(path.join(temp, "theme/theme-map-lifecycle.server.js"));
const mapping = require(path.join(temp, "theme-map.server.js"));
const embed = require(path.join(temp, "theme/app-embed.server.js"));
const sources = () => ({
  "templates/search.json": '/* Shopify generated */ {"sections":{"off":{"type":"missing","disabled":true},"main":{"type":"search-results"}},"order":["off","main"]}',
  "sections/search-results.liquid": "{%- for p in search.results -%}{% liquid\n render 'product-grid', product:p\n%}{% endfor %}",
  "snippets/product-grid.liquid": "{% render 'product-card' %}",
  "snippets/product-card.liquid": "<product-card>{{ product.title }}</product-card>",
  "config/settings_data.json": '{"current":{"blocks":{"bridge":{"type":"shopify://apps/ai-search/blocks/ai_search_bridge/extension-1","disabled":false}}}}',
});
function fixture() {
  const state = {themeId:"1", files:sources(), stored:new Map(), writes:0, reads:0, conflict:false, changeMain:false};
  const theme = () => ({id:`gid://shopify/OnlineStoreTheme/${state.themeId}`,name:`Theme ${state.themeId}`,updatedAt:"2026-09-05T00:00:00Z",processing:false,processingFailed:false});
  const admin = {async graphql(query, options={}) {
    const vars=options.variables || {};
    let data;
    if(query.includes("GetActiveThemeIdentity")) data={themes:{nodes:[theme()]}};
    else if(query.includes("GetThemeFiles")) {
      state.reads+=1;
      assert.ok(vars.filenames.length<=50);
      data={theme:{files:{nodes:vars.filenames.filter((name)=>name in state.files).map((filename)=>({filename,body:{content:state.files[filename]}}))}}};
      if(state.changeMain) {state.themeId="2";state.changeMain=false;}
    } else if(query.includes("ReadThemeMapStorage")) {
      assert.match(vars.key,/^theme_map_\d+$/);
      data={currentAppInstallation:{id:"gid://shopify/AppInstallation/1",metafield:state.stored.get(vars.key)||null}};
    } else if(query.includes("SaveThemeMap")) {
      const item=vars.metafields[0];
      const current=state.stored.get(item.key);
      if(state.conflict || item.compareDigest!==(current?.compareDigest??null)) data={metafieldsSet:{metafields:[],userErrors:[{code:"INVALID_COMPARE_DIGEST"}]}};
      else {
        state.writes+=1;
        state.stored.set(item.key,{value:item.value,compareDigest:`digest-${state.writes}`});
        data={metafieldsSet:{metafields:[{id:"saved",key:item.key}],userErrors:[]}};
      }
    } else throw new Error(`Unexpected query ${query}`);
    return Response.json({data});
  }};
  return {state,admin,theme};
}
async function main() {
  const {state,admin,theme}=fixture();
  const shop="map-test.myshopify.com";
  const maps=await Promise.all(Array.from({length:5},()=>lifecycle.getActiveThemeMap({admin,shop})));
  assert.equal(state.writes,1);
  assert.ok(maps.every((map)=>map.fingerprint===maps[0].fingerprint));
  assert.equal(maps[0].theme.id,"1");
  assert.deepEqual(maps[0].search.searchTemplateStructure[0].sectionIds,["main"]);
  assert.ok(maps[0].sources.some((file)=>file.filename==="snippets/product-card.liquid"));
  assert.ok(!JSON.stringify(maps[0]).includes("<product-card>"));
  await lifecycle.getActiveThemeMap({admin,shop});
  assert.equal(state.writes,1);
  state.files["snippets/product-card.liquid"]="<product-card>changed</product-card>";
  const changed=await lifecycle.getActiveThemeMap({admin,shop});
  assert.notEqual(changed.fingerprint,maps[0].fingerprint);
  assert.equal(state.writes,2);
  state.themeId="2";
  const second=await lifecycle.getActiveThemeMap({admin,shop});
  assert.equal(second.theme.id,"2");
  assert.ok(state.stored.has("theme_map_2"));
  state.themeId="1";
  const restored=await lifecycle.getActiveThemeMap({admin,shop});
  assert.equal(restored.theme.id,"1");
  assert.equal(restored.fingerprint,changed.fingerprint);
  assert.equal(state.writes,3);
  const savedEmbed=await embed.getAiSearchAppEmbedStatusForTheme(admin,theme());
  assert.equal(savedEmbed.enabled,true);
  state.files["config/settings_data.json"]='{"current":{},"presets":{"fake":{"blocks":{"bridge":{"type":"shopify://apps/ai-search/blocks/ai_search_bridge/extension-1"}}}}}';
  assert.equal((await embed.getAiSearchAppEmbedStatusForTheme(admin,theme())).enabled,false);
  const race=fixture();race.state.changeMain=true;
  await assert.rejects(()=>lifecycle.getActiveThemeMap({admin:race.admin,shop:"race.myshopify.com"}),/ACTIVE_THEME_CHANGED/);
  assert.equal(race.state.writes,0);
  const conflict=fixture();conflict.state.conflict=true;
  await assert.rejects(()=>lifecycle.getActiveThemeMap({admin:conflict.admin,shop:"conflict.myshopify.com"}),/CONCURRENT_UPDATE/);
  const legacy=fixture();
  delete legacy.state.files["templates/search.json"];
  legacy.state.files["templates/search.liquid"]="{% section 'search-results' %}";
  assert.equal((await mapping.buildMainThemeMap(legacy.admin)).search.searchTemplate,"templates/search.liquid");
  assert.throws(()=>mapping.numericThemeId("gid://other/1"));
  console.log("Theme Map lifecycle self-test: PASS");
}
main().catch((error)=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
