// Produces a self-contained DOM test page: network/location are mocks,
// DOMParser, custom elements, nodes and the shipped runtime are real browser APIs.
const {html,map,products,runtime:source}=require("./storefront-selftest.cjs");
const runtime=require("esbuild").transformSync(source,{minifyWhitespace:true,loader:"js"}).code;
const cases=[{name:"classic"},{name:"empty",empty:true},{name:"blocks",variant:"blocks"},{name:"missing",missing:true},{name:"changed",changedTheme:true},{name:"error",backendError:true},{name:"sku",query:"SKU123",nativeOnly:true},{name:"mixed",type:"product,page",nativeOnly:true},{name:"editor",designMode:true,nativeOnly:true}];
const encode=(value)=>JSON.stringify(value).replaceAll("<","\\u003c");
const nativePage=(handles,option)=>html(handles,option).replace(/<script[\s\S]*?<\/script>/g,"");
const seeds=cases.map((option)=>({option,initial:html(["native-old"],option).replace(JSON.stringify(map),"null").replace('<script src="/runtime.js" defer></script>',""),native1:nativePage(["alpha"],{variant:option.variant,themeId:option.changedTheme?"2":"1"}),native2:nativePage(option.missing?["alpha"]:["beta"],{variant:option.variant,themeId:option.changedTheme?"2":"1"})}));
process.stdout.write(`<!doctype html><html><head><meta charset="utf-8"><title>AI Search V3 native DOM fixtures</title></head><body><h1>Native DOM fixtures</h1><ol id="results"></ol><script>
const seeds=${encode(seeds)}, runtime=${encode(runtime)}, map=${encode(map)}, products=${encode(products)};
addEventListener("message",(event)=>{if(event.data?.fixture){const row=document.createElement("li");row.textContent=JSON.stringify(event.data);document.querySelector("#results").append(row);}});
for(const seed of seeds){
 const frame=document.createElement("iframe");frame.title=seed.option.name;frame.style.width="250px";frame.style.height="180px";
 const code=\`const seed=\${JSON.stringify(seed)},map=\${JSON.stringify(map)},products=\${JSON.stringify(products)};
 const calls={map:0,search:0,native:[],fallback:0};const errors=[];
 addEventListener("error",(event)=>errors.push(event.message));
 let fakeUrl=new URL("https://theme.test/vi/search?q="+encodeURIComponent(seed.option.query||"green snowboard")+"&type="+(seed.option.type||"product"));
 const fakeLocation={get href(){return fakeUrl.href;},get origin(){return fakeUrl.origin;},get search(){return fakeUrl.search;},get pathname(){return fakeUrl.pathname;},assign(url){fakeUrl=new URL(url,fakeUrl);},replace(url){fakeUrl=new URL(url,fakeUrl);calls.fallback++;},reload(){calls.reload=true;}};
 const fakeHistory={state:null,replaceState(state,title,url){this.state=state;fakeUrl=new URL(url,fakeUrl);},pushState(state,title,url){this.replaceState(state,title,url);}};
 const fakeWindow=new Proxy(window,{get(target,key){if(key==="location")return fakeLocation;if(key==="history")return fakeHistory;const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
 async function fakeFetch(input,options){if(options?.signal?.aborted)throw new DOMException("Aborted","AbortError");const url=new URL(input,fakeUrl);
  if(url.pathname.endsWith("/apps/ai-search")){const isMap=url.searchParams.get("mode")==="theme-map";calls[isMap?"map":"search"]++;
   if(seed.option.backendError&&!isMap)return new Response("{}",{status:503});
   return Response.json(isMap?{status:"success",theme_map:map}:{status:"success",theme_id:"1",map_fingerprint:"fp",products,target_ids:"id:2 OR id:1",pagination:{current_page:1,page_size:2,total_products:2,total_pages:1}});}
  const page=Number(url.searchParams.get("page")||1);calls.native.push(page);return new Response(page===1?seed.native1:seed.native2,{headers:{"Content-Type":"text/html"}});}
 (function(window,location,history,fetch){\${runtime}\n})(fakeWindow,fakeLocation,fakeHistory,fakeFetch);
 setTimeout(()=>{const handles=Array.from(document.querySelectorAll("#product-grid > [data-handle]")).map((node)=>node.dataset.handle);
  const expectedFallback=seed.option.missing||seed.option.changedTheme||seed.option.backendError;
  const pass=!errors.length&&(seed.option.nativeOnly?calls.search===0&&calls.map===0:expectedFallback?calls.fallback===1&&calls.search===1:handles.join(",")==="beta,alpha"&&calls.search===1&&calls.native.join(",")==="1,2");
  parent.postMessage({fixture:seed.option.name,pass,handles,calls,errors},"*");},500);\`;
 frame.srcdoc=seed.initial.replace("</body>","<script>"+code.replaceAll("</script>","<\\/script>")+"</scr"+"ipt></body>");document.body.append(frame);
}
</script></body></html>`);
