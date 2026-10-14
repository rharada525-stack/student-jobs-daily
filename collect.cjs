'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const JOB_SETTINGS={
  "timezone": "Asia/Tokyo",
  "hour": 7,
  "pages": 3,
  "maxJobsPerSource": 60,
  "sources": [
    {
      "id": "coconala",
      "name": "ココナラ",
      "automatic": true,
      "url": "https://coconala.com/requests/categories/10?recruiting=true"
    },
    {
      "id": "lancers",
      "name": "ランサーズ",
      "automatic": false,
      "url": "https://www.lancers.jp/work/search/multimedia/video?sort=started"
    },
    {
      "id": "mamaworks",
      "name": "ママワークス",
      "automatic": false,
      "url": "https://mamaworks.jp/list?lrj%5Brecruitmentjob_id%5D%5B0%5D=400"
    },
    {
      "id": "crowdworks",
      "name": "クラウドワークス",
      "automatic": true,
      "url": "https://crowdworks.jp/public/jobs/group/video_contents?order=new"
    }
  ]
};
function parseCrowdworks_(html) {
  const match = html.match(/id=["']vue-container["']\s+data=["']([^"']+)["']/);
  if (!match) throw new Error('クラウドワークスの一覧形式が変わりました');
  const data = JSON.parse(decodeHtml_(match[1]));
  if (!data.searchResult || !Array.isArray(data.searchResult.job_offers)) throw new Error('案件データがありません');
  return data.searchResult.job_offers.map(row => {
    const job = row.job_offer || {}, payment = row.payment || {};
    const fixed = payment.fixed_price_payment;
    let budget = '予算は募集ページで確認';
    if (fixed && (fixed.min_budget != null || fixed.max_budget != null)) {
      budget = (fixed.min_budget != null ? Number(fixed.min_budget).toLocaleString('ja-JP')+'円' : '') + (fixed.max_budget != null ? '〜'+Number(fixed.max_budget).toLocaleString('ja-JP')+'円' : '〜');
    } else if (payment.hourly_price_payment) budget = '時間単価制（詳細は募集ページ）';
    return {id:'crowdworks-'+job.id,title:cleanText_(job.title),url:'https://crowdworks.jp/public/jobs/'+job.id,budget:budget,deadline:job.expired_on || '',postedAt:job.last_released_at || '',status:job.status || '',private:!!job.is_login_required,filterText:cleanText_(job.description_digest || '')};
  });
}

function parseCoconala_(html, now) {
  const chunks = html.split(/<div\s+class=["']c-searchItemWrapper\s[^"']*["'][^>]*>/).slice(1);
  if (!chunks.length && !hasEmptyResults_(html)) throw new Error('ココナラの一覧形式が変わりました');
  return chunks.map(block => {
    const link = block.match(/href=["'](?:https:\/\/coconala\.com)?\/requests\/(\d+)["']/);
    const title = block.match(/class=["']c-itemInfo_title["'][^>]*>([\s\S]*?)<\/div>/);
    if (!link || !title) return null;
    // A card is bounded by the next wrapper; scripts are discarded before text extraction.
    block = block.split(/<script\b/i)[0];
    const plain = cleanText_(block);
    const description = block.match(/class=["']c-itemInfo_description["'][^>]*>([\s\S]*?)<\/div>/);
    const budget = plain.match(/予算\s*([\s\S]{0,100}?)\s*応募者数/);
    const deadlineText = (plain.match(/募集期限\s*([\s\S]{0,90}?)(?:ブックマーク|投稿|$)/) || [])[1] || '';
    const monthDay = deadlineText.match(/(\d{1,2})月(\d{1,2})日まで/);
    let deadline = '';
    if (monthDay) {
      const today = jstDay_(now), year = Number(today.slice(0,4));
      deadline = year+'-'+('0'+monthDay[1]).slice(-2)+'-'+('0'+monthDay[2]).slice(-2);
      if (deadline < today && /あと\d+日/.test(deadlineText)) deadline = (year+1)+deadline.slice(4);
    }
    const posted = block.match(/title=["'](\d{4})年(\d{1,2})月(\d{1,2})日[^"']*?(\d{1,2}):(\d{2})["']/);
    const postedAt = posted ? posted[1]+'-'+('0'+posted[2]).slice(-2)+'-'+('0'+posted[3]).slice(-2)+'T'+('0'+posted[4]).slice(-2)+':'+posted[5]+':00+09:00' : '';
    return {id:'coconala-'+link[1],title:cleanText_(title[1]),url:'https://coconala.com/requests/'+link[1],budget:budget?budget[1].replace(/\s+/g,'').slice(0,70):'予算は募集ページで確認',deadline:deadline,postedAt:postedAt,status:/募集終了|受付終了/.test(deadlineText)?'closed':'released',private:false,filterText:description?cleanText_(description[1]):''};
  }).filter(Boolean);
}

function hasEmptyResults_(html) { return /(?:該当する(?:仕事|案件|募集).{0,15}(?:ありません|見つかりません)|0\s*件中|該当件数.{0,10}0\s*件)/.test(cleanText_(html)); }
function eligibleJob_(job, now) {
  if (/(?:演者募集|出演者|出演モデル|撮影者募集|撮影のみ)/.test(job.title)) return false;
  if (/(?:台本|歌詞|ライター|スライド|サムネイル|ナレーション|音声収録)/.test(job.title) && !/(?:編集|動画制作|動画作成|映像制作|映像作成|テロップ)/.test(job.title)) return false;
  if (!job.title || job.private || job.status !== 'released' || (job.deadline && job.deadline < jstDay_(now))) return false;
  if (/(?:インタビューに出て|インタビュー協力|素材提供|撮影モデル|モデル募集|ナレーター募集|声優募集|アンケート)/.test(job.title)) return false;
  if (!/(?:動画編集|映像編集|動画制作|動画作成|YouTube|youtube|ショート動画|Premiere|プレミア|カット編集|テロップ|字幕編集)/i.test(job.title+' '+job.filterText)) return false;
  if (/(?:受講料|登録料|教材購入|有料講座|公式LINE|LINEに登録|LINE登録|仮払い前.{0,12}(?:作業|納品)|商品.{0,8}(?:購入して|購入する必要))/.test(job.title+' '+job.filterText)) return false;
  return true;
}
function publicJob_(job) { return {id:job.id,title:job.title,url:job.url,budget:job.budget,deadline:job.deadline,postedAt:job.postedAt}; }
function decodeHtml_(value) { return String(value || '').replace(/&(?:quot|apos|amp|lt|gt|nbsp);|&#(?:x[\da-f]+|\d+);/gi, token => { const map={'&quot;':'"','&apos;':"'",'&amp;':'&','&lt;':'<','&gt;':'>','&nbsp;':' '}; if(map[token.toLowerCase()]!=null) return map[token.toLowerCase()]; return String.fromCodePoint(token[2].toLowerCase()==='x'?parseInt(token.slice(3,-1),16):parseInt(token.slice(2,-1),10)); }); }
function cleanText_(value) { return decodeHtml_(String(value || '').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim(); }
function jstDay_(date) { return new Date(date.getTime()+9*60*60*1000).toISOString().slice(0,10); }


async function fetchPage(url,fetcher=fetch){
  const response=await fetcher(url,{signal:AbortSignal.timeout(25000),headers:{'User-Agent':'StudentJobLinkCollector/1.0 (+https://github.com/rharada525-stack/student-jobs-daily)'}});
  if(response.status!==200)throw new Error('取得元の応答: HTTP '+response.status);
  const html=await response.text();
  if(html.length<2000||html.length>4000000)throw new Error('取得元の内容を確認できませんでした');
  return html;
}
async function update(previous,now=new Date(),fetcher=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms))){
  const sources=[];
  for(const source of JOB_SETTINGS.sources){
    if(!source.automatic){sources.push({...source,jobs:[]});continue;}
    const prior=(previous.sources||[]).find(s=>s.id===source.id)||{jobs:[],lastSuccess:null};
    try{
      const seen=new Set(),jobs=[];let rawCount=0;
      for(let page=1;page<=JOB_SETTINGS.pages;page++){
        const html=await fetchPage(source.url+'&page='+page,fetcher);
        const parsed=source.id==='crowdworks'?parseCrowdworks_(html):parseCoconala_(html,now);
        if(!parsed.length&&page===1&&!hasEmptyResults_(html))throw new Error('案件一覧の形式を確認できませんでした');
        rawCount+=parsed.length;
        for(const job of parsed){if(seen.has(job.id))continue;seen.add(job.id);if(eligibleJob_(job,now)&&/^https:\/\/(coconala\.com\/requests|crowdworks\.jp\/public\/jobs)\/\d+$/.test(job.url))jobs.push(publicJob_(job));}
        if(!parsed.length||parsed.length<(source.id==='coconala'?40:50))break;
        if(page<JOB_SETTINGS.pages)await pause(1500);
      }
      jobs.sort((a,b)=>String(b.postedAt||'').localeCompare(String(a.postedAt||'')));
      sources.push({...source,jobs:jobs.slice(0,JOB_SETTINGS.maxJobsPerSource),lastSuccess:now.toISOString(),lastAttempt:now.toISOString(),error:null,rawCount});
    }catch(error){
      sources.push({...source,jobs:(prior.jobs||[]).map(publicJob_),lastSuccess:prior.lastSuccess||null,lastAttempt:now.toISOString(),error:String(error.message||error).slice(0,180)});
    }
  }
  return {schemaVersion:1,lastAttempt:now.toISOString(),sources};
}
async function main(){
  const file=path.join(__dirname,'jobs.json');
  let previous={sources:[]};try{previous=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const state=await update(previous);const temporary=file+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(state,null,2)+'\n');await fs.rename(temporary,file);
  console.log(JSON.stringify(state.sources.map(s=>({source:s.id,count:s.jobs.length,lastSuccess:s.lastSuccess,error:s.error||null})),null,2));
  if(state.sources.some(s=>s.automatic&&s.error))process.exitCode=1;
}
module.exports={update,JOB_SETTINGS,parseCrowdworks_,parseCoconala_,eligibleJob_,publicJob_};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});