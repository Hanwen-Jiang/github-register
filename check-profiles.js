const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const profiles = ['.chrome-a6-cid','.chrome-a6-probe5','.chrome-ap3','.chrome-ap4','.chrome-a6-id','.chrome-a6-probe','.chrome-m20','.chrome-a6-probe4','.chrome-a6-probe2','.chrome-a6-probe3'];
(async()=>{
 for (const prof of profiles) {
  if (!fs.existsSync(prof)) continue;
  process.stdout.write(`===== ${prof}\n`);
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(path.resolve(prof),{
      headless:true,
      executablePath:process.env.CHROMIUM_PATH,
      args:['--no-sandbox','--disable-dev-shm-usage'],
      proxy: process.env.PROXY ? {server: process.env.PROXY} : undefined,
      viewport:{width:1000,height:800},
    });
    const page=ctx.pages()[0]||await ctx.newPage();
    await page.goto('https://github.com/settings/profile',{waitUntil:'domcontentloaded',timeout:15000}).catch(e=>console.log('gotoerr',e.message));
    await page.waitForTimeout(800);
    console.log(page.url());
  } catch(e) { console.log('ERR', e.message); }
  finally { if (ctx) await ctx.close().catch(()=>{}); }
 }
})();
