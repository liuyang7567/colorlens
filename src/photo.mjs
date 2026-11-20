import {check} from './common.mjs';
const round=(value,digits=4)=>Number(value.toFixed(digits));
const radians=value=>value*Math.PI/180;
const degrees=value=>value*180/Math.PI;
export function deltaE(firstLab,secondLab) {
  const [lightFirst,redFirst,blueFirst]=firstLab, [lightSecond,redSecond,blueSecond]=secondLab;
  const chromaFirst=Math.hypot(redFirst,blueFirst),chromaSecond=Math.hypot(redSecond,blueSecond);
  const averageChroma=(chromaFirst+chromaSecond)/2;
  const correction=.5*(1-Math.sqrt(averageChroma**7/(averageChroma**7+25**7)));
  const adjustedFirst=(1+correction)*redFirst,adjustedSecond=(1+correction)*redSecond;
  const magnitudeFirst=Math.hypot(adjustedFirst,blueFirst),magnitudeSecond=Math.hypot(adjustedSecond,blueSecond);
  const hue=(red,blue)=>red===0 && blue===0?0:(degrees(Math.atan2(blue,red))+360)%360;
  const hueFirst=hue(adjustedFirst,blueFirst),hueSecond=hue(adjustedSecond,blueSecond);
  let hueDifference=hueSecond-hueFirst;
  if (!magnitudeFirst || !magnitudeSecond) hueDifference=0;
  else if (hueDifference>180) hueDifference-=360;
  else if (hueDifference< -180) hueDifference+=360;
  const lightDifference=lightSecond-lightFirst,chromaDifference=magnitudeSecond-magnitudeFirst;
  const hueDistance=2*Math.sqrt(magnitudeFirst*magnitudeSecond)*Math.sin(radians(hueDifference/2));
  const meanLight=(lightFirst+lightSecond)/2,meanMagnitude=(magnitudeFirst+magnitudeSecond)/2;
  let meanHue=(hueFirst+hueSecond)/2;
  if (!magnitudeFirst || !magnitudeSecond) meanHue=hueFirst+hueSecond;
  else if (Math.abs(hueFirst-hueSecond)>180) meanHue+=(hueFirst+hueSecond<360?180:-180);
  const weight=1-.17*Math.cos(radians(meanHue-30))+.24*Math.cos(radians(2*meanHue))+.32*Math.cos(radians(3*meanHue+6))-.20*Math.cos(radians(4*meanHue-63));
  const lightScale=1+.015*(meanLight-50)**2/Math.sqrt(20+(meanLight-50)**2);
  const chromaScale=1+.045*meanMagnitude,hueScale=1+.015*meanMagnitude*weight;
  const rotation=-2*Math.sqrt(meanMagnitude**7/(meanMagnitude**7+25**7))*Math.sin(radians(60*Math.exp(-(((meanHue-275)/25)**2))));
  return Math.sqrt((lightDifference/lightScale)**2+(chromaDifference/chromaScale)**2+(hueDistance/hueScale)**2+rotation*(chromaDifference/chromaScale)*(hueDistance/hueScale));
}
export function rgbLab(rgb) {
  const linear=rgb.map(value=>{const normalized=value/255;return normalized>.04045?((normalized+.055)/1.055)**2.4:normalized/12.92;});
  const [red,green,blue]=linear;
  const xyz=[(.412453*red+.357580*green+.180423*blue)/.95047,.212671*red+.715160*green+.072169*blue,(.019334*red+.119193*green+.950227*blue)/1.08883].map(value=>value>.008856?Math.cbrt(value):7.787*value+16/116);
  return [116*xyz[1]-16,500*(xyz[0]-xyz[1]),200*(xyz[1]-xyz[2])];
}
function median(values) {
  values.sort();
  const middle=Math.floor(values.length/2);
  return values.length%2?values[middle]:(values[middle-1]+values[middle])/2;
}
function hsv(rgb) {
  const maximum=Math.max(...rgb),minimum=Math.min(...rgb),range=maximum-minimum;
  let hue=0;
  if (range) hue=maximum===rgb[0]?(rgb[1]-rgb[2])/range:maximum===rgb[1]?(rgb[2]-rgb[0])/range+2:(rgb[0]-rgb[1])/range+4;
  return [((hue*60)%360+360)%360,maximum?range/maximum*100:0,maximum/255*100].map(value=>round(value,3));
}
export function analyzePixels(width,height,pixels,rois,controlId,parameters,simulated=false,metadata={}) {
  const params={inset:.1,min_pixels:400,clip_warning:.05,...parameters};
  check(Number.isFinite(params.inset)&&params.inset>=0&&params.inset<=.3 && Number.isInteger(params.min_pixels)&&params.min_pixels>=25&&params.min_pixels<=100000 && Number.isFinite(params.clip_warning)&&params.clip_warning>=.001&&params.clip_warning<=1,'采样参数无效。');
  check(Array.isArray(rois)&&rois.length>0&&rois.length<=32 && new Set(rois.map(roi=>roi.id)).size===rois.length && rois.some(roi=>roi.id===controlId),'请选择 1–32 个不重复区域和有效对照。');
  let totalPixels=0;
  for (const roi of rois) {
    check(['x','y','w','h'].every(key=>Number.isSafeInteger(roi[key])) && roi.x>=0&&roi.y>=0&&roi.w>0&&roi.h>0 && roi.x+roi.w<=width&&roi.y+roi.h<=height,'区域坐标无效或超出图像。');
    totalPixels+=roi.w*roi.h;
  }
  check(totalPixels<=2000000,'浏览器版每次最多采样 200 万个区域像素，请缩小 ROI；不自动降采样。');
  const results=rois.map(roi=>{
    const insetX=Math.floor(roi.w*params.inset),insetY=Math.floor(roi.h*params.inset);
    const sampleWidth=roi.w-insetX*2,sampleHeight=roi.h-insetY*2,count=sampleWidth*sampleHeight;
    const left=roi.x+insetX,top=roi.y+insetY;
    const result={id:roi.id,label:roi.label,role:roi.id===controlId?'control':'sample',sample_bounds:[left,top,left+sampleWidth,top+sampleHeight],pixels:count,delta_e:null,status:'ok',warnings:[]};
    if (count<params.min_pixels) return {...result,status:'invalid',warnings:['有效像素过少，请扩大区域或重新拍摄。'],rgb:null,hsv:null,lab:null,spread:null,clipped:null,dark:null,sharpness:null};
    const rgbChannels=Array.from({length:3},()=>new Float64Array(count));
    const labs=Array.from({length:3},()=>new Float64Array(count));
    const gray=new Float64Array(count);
    let clipped=0,dark=0,white=0;
    for (let position=0;position<count;position++) {
      const pixel=((top+Math.floor(position/sampleWidth))*width+left+position%sampleWidth)*4;
      check(pixels[pixel+3]===255,'区域含透明像素，请使用不透明实验照片。');
      const rgb=[pixels[pixel],pixels[pixel+1],pixels[pixel+2]],lab=rgbLab(rgb);
      for (let channel=0;channel<3;channel++) {rgbChannels[channel][position]=rgb[channel];labs[channel][position]=lab[channel];}
      gray[position]=(rgb[0]+rgb[1]+rgb[2])/3;
      if (Math.max(...rgb)>=254) clipped++;
      if (Math.max(...rgb)<=5) dark++;
      if (Math.min(...rgb)>=245) white++;
    }
    const rgb=rgbChannels.map(channel=>median(channel));
    const lab=labs.map(channel=>median(channel.slice()));
    const distances=new Float64Array(count);
    let laplaceSum=0,laplaceSquares=0;
    for (let position=0;position<count;position++) {
      distances[position]=Math.hypot(labs[0][position]-lab[0],labs[1][position]-lab[1],labs[2][position]-lab[2]);
      const column=position%sampleWidth,row=Math.floor(position/sampleWidth);
      const laplace=gray[column?position-1:position]+gray[column<sampleWidth-1?position+1:position]+gray[row?position-sampleWidth:position]+gray[row<sampleHeight-1?position+sampleWidth:position]-4*gray[position];
      laplaceSum+=laplace;laplaceSquares+=laplace*laplace;
    }
    const sharpness=Math.max(0,laplaceSquares/count-(laplaceSum/count)**2),spread=median(distances);
    if (clipped/count>=params.clip_warning) result.warnings.push('存在通道饱和，颜色差异可能被压缩；浅色样本也可能触发此提示。');
    if (dark/count>.1) result.warnings.push('暗部像素较多，请检查遮挡和曝光。');
    if (white/count>.1) result.warnings.push('高亮区域较多，请检查反光；未自动剔除像素。');
    if (Math.min(sampleWidth,sampleHeight)<20) result.warnings.push('采样区域较窄，建议提高有效分辨率。');
    if (spread>8) result.warnings.push('区域颜色不均匀，请检查管壁、背景、阴影或反光。');
    if (sharpness<2) result.warnings.push('纹理较少或可能失焦；均匀溶液也会触发，请人工复核。');
    return {...result,status:result.warnings.length?'caution':'ok',rgb:rgb.map(value=>round(value,2)),hsv:hsv(rgb),lab:lab.map(value=>round(value,5)),spread:round(spread),clipped:round(clipped/count,5),dark:round(dark/count,5),sharpness:round(sharpness,3)};
  });
  const matrix=results.map(()=>results.map(()=>null)),control=results.find(row=>row.id===controlId);
  let closest=null;
  for (let firstIndex=0;firstIndex<results.length;firstIndex++) {
    const row=results[firstIndex];
    if (!row.lab) continue;
    if (control.lab) row.delta_e=round(deltaE(row.lab,control.lab));
    for (let secondIndex=firstIndex;secondIndex<results.length;secondIndex++) {
      const other=results[secondIndex];
      if (!other.lab) continue;
      const difference=round(deltaE(row.lab,other.lab));
      matrix[firstIndex][secondIndex]=matrix[secondIndex][firstIndex]=difference;
      if (secondIndex>firstIndex && (!closest || difference<closest.delta_e)) closest={ids:[row.id,other.id],labels:[row.label,other.label],delta_e:difference};
    }
  }
  return {analysis_type:'photo',parameters:params,rois,control_id:controlId,results,matrix,closest,simulated,image:metadata,algorithm:'browser-srgb-lab-de00-1',provenance:'浏览器 sRGB Canvas 解码与计算，未由云端重新测量；含 ICC 的图像可能与旧 Python 版不同。',disclaimer:'照片只支持同图相对颜色比较，不能替代吸光度，不估计浓度、酶活性或统计显著性；非临床用途。',quality_method:'未在真实实验照片上验证的工程阈值，不自动剔除像素。'};
}
