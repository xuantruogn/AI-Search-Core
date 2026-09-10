/* eslint-disable no-console */
const http=require("node:http");
const {html,map,products,runtime}=require("./storefront-selftest.cjs");
const cases={classic:{},empty:{empty:true},blocks:{variant:"blocks"},missing:{missing:true},changed:{changedTheme:true},error:{backendError:true},sku:{query:"SKU123"},mixed:{type:"product,page"},editor:{designMode:true}};
const stats={};
const server=http.createServer((request,response)=>{
  const url=new URL(request.url,"http://localhost");
  const key=url.pathname.split("/")[2];const option=cases[key]||{};
  if(url.pathname==="/stats") {response.setHeader("Content-Type","application/json");response.end(JSON.stringify(stats));return;}
  if(url.pathname==="/") {response.end(`<h1>Native theme runtime fixtures</h1>${Object.entries(cases).map(([name,value])=>`<p><a href="/case/${name}/vi/search?q=${encodeURIComponent(value.query||"green snowboard")}&type=${value.type||"product"}">${name}</a></p>`).join("")}`);return;}
  if(url.pathname==="/runtime.js") {response.setHeader("Content-Type","application/javascript");response.end(runtime);return;}
  stats[key] ||= {map:0,search:0,native:[],fallback:0};
  if(url.pathname.endsWith("/apps/ai-search")) {
    const isMap=url.searchParams.get("mode")==="theme-map";stats[key][isMap?"map":"search"]+=1;
    response.setHeader("Content-Type","application/json");
    if(option.backendError&&!isMap) {response.statusCode=503;response.end("{}");return;}
    response.end(JSON.stringify(isMap?{status:"success",theme_map:map}:{status:"success",theme_id:"1",map_fingerprint:"fp",products,target_ids:"id:2 OR id:1",pagination:{current_page:1,page_size:2,total_products:2,total_pages:1}}));return;
  }
  const internal=(url.searchParams.get("q")||"").startsWith("id:");
  const page=Number(url.searchParams.get("page")||1);
  if(internal) stats[key].native.push(page);
  else if(url.searchParams.has("_ai_search_bypass")) stats[key].fallback+=1;
  const markup=internal?html(page===1?["alpha"]:option.missing?["alpha"]:["beta"],{variant:option.variant,themeId:option.changedTheme?"2":"1"}):html(["native-old"],option);
  response.setHeader("Content-Type","text/html");
  response.end(markup.replaceAll('"/apps/ai-search"',`"/case/${key}/apps/ai-search"`).replaceAll('"/vi/search"',`"/case/${key}/vi/search"`));
});
server.listen(Number(process.env.AI_SEARCH_FIXTURE_PORT||8765),"0.0.0.0",()=>console.log("Theme fixtures ready on port 8765"));
