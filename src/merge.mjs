export const sameValue=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
export function mergeFields(base,local,remote,fields){
  const data={...remote},conflicts=[];
  for(const field of fields){
    if(sameValue(local[field],base[field]))continue;
    if(!sameValue(remote[field],base[field])&&!sameValue(remote[field],local[field]))conflicts.push(field);
    data[field]=local[field];
  }
  return {data,conflicts};
}
