export async function requestPrivateSuggestions(input,{endpoint,token,fetcher=fetch}={}){
 if(!endpoint||!token||token.length<32)throw Error('personalization_unavailable');
 const url=new URL(endpoint);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/v1/next-day')throw Error('personalization_unavailable');
 const response=await fetcher(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(input),signal:AbortSignal.timeout(8000)});
 if(response.status===422)throw Error('invalid_planning_options');
 if(!response.ok)throw Error('personalization_unavailable');
 const body=await response.text();if(body.length>65536)throw Error('invalid_engine_response');
 return JSON.parse(body);
}
