import {gunzip,gzip,zopfli} from "./gzip_zopfli.mjs";
onmessage=async({data})=>postMessage(
  data.level===undefined?(data.zopfli?zopfli(data.bytes):gunzip(data)):gzip(data.bytes,data.level)
);
postMessage('ready');
