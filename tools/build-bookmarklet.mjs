// Builds the no-extension version: dist/bookmarklet.txt (the bookmark URL) and dist/install.html.
// Usage: node tools/build-bookmarklet.mjs
import fs from 'fs';
import path from 'path';
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
let src = fs.readFileSync(path.join(root, 'trackit-truck-filter.user.js'), 'utf8');

// Drop the userscript header/intro comment and whole-line comments to keep the bookmark short.
src = src.slice(src.indexOf('(function () {'));
src = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/^\s+/, '')).join('\n');

// The tool runs in this page, and in any same-origin frame, in case the map sits inside a frame.
// If no frame is the map page, the panel is forced to show in the top window so a click is never silent.
const wrapper = `(function(){
function run(){${src}}
var found=false;
function visit(w,top){
  var isMap=false;
  try{isMap=/map\\.jsp/i.test(w.location.pathname);}catch(e){return;}
  if(isMap)found=true;
  try{
    if(top)run();
    else if(!w.__tkf)w.eval('('+run.toString()+')()');
  }catch(e){console.warn('TrackIt tool: could not start in a frame',e);}
  for(var i=0;i<w.frames.length;i++)visit(w.frames[i],false);
}
visit(window,true);
if(!found){window.__tkfForcePanel=true;}
})();`;

const url = 'javascript:' + encodeURIComponent(wrapper);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'bookmarklet.txt'), url);
fs.writeFileSync(path.join(root, 'dist', 'bookmarklet.js'), wrapper);
console.log('bookmarklet length:', url.length);

// Install page with a drag-to-bookmarks-bar button.
const tpl = fs.readFileSync(path.join(root, 'tools', 'install-page.template.html'), 'utf8');
const esc = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
fs.writeFileSync(path.join(root, 'dist', 'install.html'),
  tpl.replaceAll('__BOOKMARKLET__', esc).replace('__SIZE__', String(Math.round(url.length / 1024))));
