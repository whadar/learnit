import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport:{width:960,height:540} });
await p.setContent(`<canvas id=c></canvas><script>
const gl=document.getElementById('c').getContext('webgl2');
const dbg=gl&&gl.getExtension('WEBGL_debug_renderer_info');
window.__r = gl ? {ok:true, ver:gl.getParameter(gl.VERSION), glsl:gl.getParameter(gl.SHADING_LANGUAGE_VERSION), rend:dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):'n/a', maxTex:gl.getParameter(gl.MAX_TEXTURE_SIZE), maxSamples:gl.getParameter(gl.MAX_SAMPLES), cbf:!!gl.getExtension('EXT_color_buffer_float'), aniso:!!gl.getExtension('EXT_texture_filter_anisotropic'), s3tc:!!gl.getExtension('WEBGL_compressed_texture_s3tc')} : {ok:false};
</script>`);
console.log(JSON.stringify(await p.evaluate(()=>window.__r)));
await b.close();
