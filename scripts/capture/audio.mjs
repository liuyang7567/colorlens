// 16 kHz, mono, signed 16-bit PCM. Keep inner pauses and 250 ms around speech.
export function trimQuietEdges(pcm){
  const length=pcm.length-pcm.length%2,window=640;let first=length,last=0,active=0;
  for(let offset=0;offset<length;offset+=window){const end=Math.min(length,offset+window);let sum=0;
    for(let position=offset;position<end;position+=2)sum+=(pcm.readInt16LE(position)/32768)**2;
    if(Math.sqrt(sum/((end-offset)/2))>=0.006){first=Math.min(first,offset);last=end;active++;}
  }
  return active>=3?pcm.subarray(Math.max(0,first-8000),Math.min(length,last+8000)):null;
}
export function pcmWave(input){
  const pcm=input.subarray(0,input.length-input.length%2),header=Buffer.alloc(44);
  header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}
