import {rgbLab,deltaE} from './photo.mjs';

const ensure=(value,message)=>{if(!value)throw new Error(message);};
export const linearColor=rgb=>rgb.map(value=>{const normalized=value/255;return normalized<=0.04045?normalized/12.92:((normalized+0.055)/1.055)**2.4;});
const encoded=value=>255*(value<=0.0031308?12.92*value:1.055*value**(1/2.4)-0.055);
function validRgb(rgb){return Array.isArray(rgb)&&rgb.length===3&&rgb.every(value=>Number.isFinite(value)&&value>=0&&value<=255);}
function solve(matrix,values){
  const size=values.length,system=matrix.map((row,index)=>[...row,values[index]]);
  for(let column=0;column<size;column++){
    let pivot=column;for(let row=column+1;row<size;row++)if(Math.abs(system[row][column])>Math.abs(system[pivot][column]))pivot=row;
    ensure(Math.abs(system[pivot][column])>1e-9,'色块信息不足或孔板四角退化，请重新选择。');
    [system[column],system[pivot]]=[system[pivot],system[column]];const scale=system[column][column];
    for(let index=column;index<=size;index++)system[column][index]/=scale;
    for(let row=0;row<size;row++){if(row===column)continue;const factor=system[row][column];for(let index=column;index<=size;index++)system[row][index]-=factor*system[column][index];}
  }
  return system.map(row=>row[size]);
}
export function applyColorMatrix(rgb,matrix){
  ensure(validRgb(rgb)&&Array.isArray(matrix)&&matrix.length===3&&matrix.every(row=>Array.isArray(row)&&row.length===4&&row.every(Number.isFinite)),'颜色矩阵无效。');
  const input=[...linearColor(rgb),1],output=matrix.map(row=>row.reduce((sum,value,index)=>sum+value*input[index],0));
  return {rgb:output.map(value=>encoded(Math.max(0,Math.min(1,value)))),clipped:output.some(value=>value< -0.001||value>1.001)};
}
export function fitColorMatrix(current,baseline){
  ensure(Array.isArray(current)&&current.length>=6&&current.length<=24&&Array.isArray(baseline)&&current.length===baseline.length&&[...current,...baseline].every(validRgb),'多色块校正需要 6–24 个对应色块。');
  const design=current.map(rgb=>[...linearColor(rgb),1]),target=baseline.map(linearColor);
  const normal=Array.from({length:4},(_,row)=>Array.from({length:4},(_,column)=>design.reduce((sum,values)=>sum+values[row]*values[column],0)));
  const matrix=Array.from({length:3},(_,channel)=>solve(normal,Array.from({length:4},(_,column)=>design.reduce((sum,values,index)=>sum+values[column]*target[index][channel],0))));
  ensure(matrix.flat().every(value=>Number.isFinite(value)&&Math.abs(value)<20),'颜色矩阵不稳定，请增加不同颜色的参考块。');
  const residual=current.reduce((sum,rgb,index)=>sum+deltaE(rgbLab(applyColorMatrix(rgb,matrix).rgb),rgbLab(baseline[index])),0)/current.length;
  ensure(Number.isFinite(residual)&&residual<=5,'色卡拟合误差过大，请检查顺序、反光和位置。');
  return {matrix,residual};
}
export function plateProjection(corners,width,height){
  ensure(Array.isArray(corners)&&corners.length===4&&corners.every(point=>point&&Number.isFinite(point.x)&&Number.isFinite(point.y)&&point.x>=0&&point.y>=0&&point.x<width&&point.y<height),'请按左上、右上、右下、左下选取四角。');
  for(let index=0;index<4;index++){
    const first=corners[index],second=corners[(index+1)%4],third=corners[(index+2)%4];
    ensure((second.x-first.x)*(third.y-second.y)-(second.y-first.y)*(third.x-second.x)>10,'孔板四角顺序交叉、方向错误或区域过小。');
  }
  const design=[],target=[];
  for(const [index,[horizontal,vertical]] of [[0,0],[1,0],[1,1],[0,1]].entries()){
    const point=corners[index];design.push([horizontal,vertical,1,0,0,0,-horizontal*point.x,-vertical*point.x]);target.push(point.x);
    design.push([0,0,0,horizontal,vertical,1,-horizontal*point.y,-vertical*point.y]);target.push(point.y);
  }
  const coefficients=solve(design,target);
  return (horizontal,vertical)=>{const divisor=coefficients[6]*horizontal+coefficients[7]*vertical+1;ensure(divisor>1e-6,'孔板透视角度过大。');return {x:(coefficients[0]*horizontal+coefficients[1]*vertical+coefficients[2])/divisor,y:(coefficients[3]*horizontal+coefficients[4]*vertical+coefficients[5])/divisor};};
}
export function projectedWells(width,height,pixels,corners,rows=8,columns=12){
  ensure([[2,3],[3,4],[4,6],[6,8],[8,12]].some(pair=>pair[0]===rows&&pair[1]===columns)&&pixels.length===width*height*4,'孔板类型或图像无效。');
  const project=plateProjection(corners,width,height),wells=[];
  for(let row=0;row<rows;row++)for(let column=0;column<columns;column++){
    const totals=[0,0,0],seen=new Set();let clipped=0;
    for(let vertical=0;vertical<7;vertical++)for(let horizontal=0;horizontal<7;horizontal++){
      const point=project((column+0.3+horizontal/15)/columns,(row+0.3+vertical/15)/rows),left=Math.round(point.x),top=Math.round(point.y);
      ensure(left>=0&&top>=0&&left<width&&top<height,'孔位越出画面。');const position=(top*width+left)*4;if(seen.has(position))continue;seen.add(position);
      for(let channel=0;channel<3;channel++)totals[channel]+=pixels[position+channel];
      if([0,1,2].some(channel=>pixels[position+channel]>=250))clipped++;
    }
    ensure(seen.size>=9,'部分孔位像素不足，请靠近或减小拍摄倾角。');wells.push({label:String.fromCharCode(65+row)+(column+1),rgb:totals.map(value=>value/seen.size),clipped:clipped/seen.size});
  }
  return wells;
}
