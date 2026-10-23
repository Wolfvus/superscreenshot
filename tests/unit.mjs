import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');

test('English and Spanish cover UI keys and preserve substitutions', async () => {
  const en = JSON.parse(await read('_locales/en/messages.json'));
  const es = JSON.parse(await read('_locales/es/messages.json'));
  assert.deepEqual(Object.keys(es), Object.keys(en));
  for (const key of Object.keys(en)) {
    assert.ok(es[key].message.trim());
    assert.deepEqual(es[key].message.match(/\$\d/g), en[key].message.match(/\$\d/g));
  }
  for (const file of ['popup.js','preview.js','background.js','popup.html','preview.html','manifest.json']) {
    const source = await read(file);
    for (const match of source.matchAll(/\bt\("(\w+)"|data-i18n(?:-[\w-]+)?="(\w+)"|__MSG_(\w+)__/g)) {
      assert.ok(en[match[1] || match[2] || match[3]], `${file}: missing ${match[0]}`);
    }
  }
});

test('unsupported browser languages label the English fallback correctly', async () => {
  const source = (await read('i18n.js')).replaceAll('export ', '');
  for(const [locale,expected] of [['es-MX','es'],['en-US','en'],['de','en']]) {
    const document = { documentElement:{}, querySelectorAll:()=>[] };
    vm.runInNewContext(source+'\nlocalize();', {document,chrome:{i18n:{getUILanguage:()=>locale}}});
    assert.equal(document.documentElement.lang,expected);
  }
});

// Exercise the production stitch function with deterministic bitmap/canvas boundaries.
async function stitchHarness(options = {}) {
  const source = await read('preview.js');
  const fn = source.slice(source.indexOf('async function stitch('),source.indexOf('\nfunction enableActions'));
  const calls = [], closed = [];
  let live = 0, peak = 0;
  const context = vm.createContext({ MAX_AREA:16384*16384, MAX_SIDE:32767, t:k=>k,
    createImageBitmap:async blob => {
      live++; peak=Math.max(peak,live);
      return {width:100,height:100,close(){closed.push(blob);live--;}};
    },
    document:{createElement:()=>({getContext:()=>({fillRect(){},drawImage(...args){
      if(options.fail) throw new Error('draw failed');
      calls.push(args.slice(1));
    }}),toBlob(cb){cb('png');}})},
  });
  vm.runInContext(fn,context);
  return {stitch:context.stitch,calls,closed,peak:()=>peak};
}

test('stitch keeps only one decoded tile and trims final overlap exactly', async () => {
  const h=await stitchHarness();
  assert.equal(await h.stitch({mode:'full',windowWidth:100,windowHeight:100,documentHeight:250,
    tiles:[{blob:'a',scrollY:0},{blob:'b',scrollY:100},{blob:'c',scrollY:150}]}),'png');
  assert.deepEqual(h.calls.map(c=>Array.from(c)),[
    [0,0,100,100,0,0,100,100], [0,0,100,100,0,100,100,100], [0,50,100,50,0,200,100,50],
  ]);
  assert.deepEqual(h.closed,['a','b','c']); assert.equal(h.peak(),1);
});

test('stitch closes a bitmap on early completion and draw failure', async () => {
  for (const fail of [false,true]) {
    const h=await stitchHarness({fail});
    const capture={mode:'full',windowWidth:100,windowHeight:100,documentHeight:100,
      tiles:[{blob:'a',scrollY:0},{blob:'b',scrollY:0}]};
    if(fail) await assert.rejects(h.stitch(capture),/draw failed/);
    else await h.stitch(capture);
    assert.deepEqual(h.closed,fail?['a']:['a','b']); assert.equal(h.peak(),1);
  }
});
