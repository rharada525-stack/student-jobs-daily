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
      "automatic": true,
      "url": "https://www.lancers.jp/work/search/multimedia/video?sort=started"
    },
    {
      "id": "mamaworks",
      "name": "ママワークス",
      "automatic": true,
      "url": "https://mamaworks.jp/jobs?lrj%5Brecruitmentjob_id%5D%5B0%5D=400"
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
function publicJob_(job) {
  const basic={id:job.id,title:job.title,url:job.url,budget:job.budget};
  return /^(?:lancers|mamaworks)-/.test(job.id)?basic:{...basic,deadline:job.deadline,postedAt:job.postedAt};
}
function decodeHtml_(value) { return String(value || '').replace(/&(?:quot|apos|amp|lt|gt|nbsp);|&#(?:x[\da-f]+|\d+);/gi, token => { const map={'&quot;':'"','&apos;':"'",'&amp;':'&','&lt;':'<','&gt;':'>','&nbsp;':' '}; if(map[token.toLowerCase()]!=null) return map[token.toLowerCase()]; return String.fromCodePoint(token[2].toLowerCase()==='x'?parseInt(token.slice(3,-1),16):parseInt(token.slice(2,-1),10)); }); }
function cleanText_(value) { return decodeHtml_(String(value || '').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim(); }
function jstDay_(date) { return new Date(date.getTime()+9*60*60*1000).toISOString().slice(0,10); }


// Only card metadata is published. Descriptions and employer statistics remain in memory.
const CW_POLICY='cw-student-exclusions-20261014-v2-video-reference';
const CW_EXCLUDED_WORDS=['既婚','未婚','結婚','独立','20代','学生','実家','子供','一人暮らし','雇用形態','スクール','精神疾患','未経験','初心者'];
const JOB_URLS={coconala:/^https:\/\/coconala\.com\/requests\/\d+$/,crowdworks:/^https:\/\/crowdworks\.jp\/public\/jobs\/\d+$/,lancers:/^https:\/\/www\.lancers\.jp\/work\/detail\/\d+$/,mamaworks:/^https:\/\/mamaworks\.jp\/job\/\d+$/};
function compactText(value){return cleanText_(decodeHtml_(value)).normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]/g,'');}
function crowdworksExclusion(title,body){
  const text=compactText(title+' '+body);
  if(CW_EXCLUDED_WORDS.some(word=>text.includes(word)))return 'excluded_keyword';
  if(/(?:同棲|同居|子持ち|子ども|お子様|お子さま|居住形態|居住状況|住居形態|家族構成|家庭環境|配偶者|ひとり暮らし)/.test(text))return 'personal_questions';
  if(/(?:現在|今|ご).{0,5}職業|職業.{0,8}(?:教|記入|回答|入力)|職業[：:]/.test(text))return 'occupation_question';
  if(/(?:[1-9]0代)(?:限定|の方|歓迎|活躍)|年代.{0,8}(?:限定|募集)|受講(?:経験|歴)|講座(?:経験|歴)/.test(text))return 'age_or_school';
  if(/(?:スキル|実力|能力).{0,35}(?:固定|月額|月収).{0,10}(?:\d{2,}万|\d{6,})|(?:誰でも|簡単に|必ず).{0,15}(?:稼げ|高収入|月収)/.test(text))return 'income_inducement';
  const friendly=[/(?:初心者|未経験).{0,8}(?:大歓迎|歓迎|OK|可)/i,/(?:最初|初めて).{0,8}実績|実績(?:づくり|作り)/,/スクール.{0,15}優遇/,/(?:スキル|技術|知識).{0,20}(?:獲得|身につ|習得)/,/マニュアル.{0,8}(?:完備|用意|あり)|(?:サポート|フォロー).{0,8}(?:充実|万全|手厚)/];
  return friendly.filter(pattern=>pattern.test(text)).length>=2?'beginner_inducements':null;
}
function parseLancers_(html,now){
  const blocks=html.split(/<div\b[^>]*class=["']p-search-job-media\s+c-media\b[^"']*["'][^>]*>/).slice(1);
  if(!blocks.length&&!hasEmptyResults_(html))throw new Error('ランサーズの一覧形式が変わりました');
  return blocks.map(block=>{
    const anchor=block.match(/<a\b[^>]*class=["'][^"']*p-search-job-media__title\b[^"']*["'][^>]*href=["']\/work\/detail\/(\d+)["'][^>]*>([\s\S]*?)<\/a>/);
    if(!anchor)return null;
    const title=cleanText_(anchor[2].replace(/<ul\b[\s\S]*?<\/ul>/gi,''));
    const price=block.match(/<span\b[^>]*class=["']p-search-job-media__price["'][^>]*>([\s\S]*?)<\/div>/);
    const body=block.match(/class=["'][^"']*c-media__description\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/);
    const remaining=cleanText_(block.match(/class=["']p-search-job-media__time-remaining["'][^>]*>([\s\S]*?)<\/span>/)?.[1]||'');
    const days=remaining.match(/あと(\d+)日/);const deadline=days?jstDay_(new Date(now.getTime()+Number(days[1])*86400000)):'';
    return {id:'lancers-'+anchor[1],title,url:'https://www.lancers.jp/work/detail/'+anchor[1],budget:price?cleanText_(price[1]).slice(0,150):'報酬は募集ページで確認',deadline,postedAt:'',status:/p-search-job-media__time--open/.test(block)?'released':'closed',private:false,filterText:body?cleanText_(body[1]):''};
  }).filter(Boolean);
}
function parseMamaworks_(html){
  const blocks=html.split(/<li\b[^>]*class=["']p-recruit-index__result-box["'][^>]*itemtype=["']https:\/\/schema.org\/JobPosting["'][^>]*>/).slice(1);
  if(!blocks.length&&!hasEmptyResults_(html))throw new Error('ママワークスの一覧形式が変わりました');
  return blocks.map(block=>{
    block=block.split(/<\/li>/)[0];
    const id=block.match(/href=["']https:\/\/mamaworks\.jp\/job\/(\d+)["']/);
    const title=block.match(/<h2\b[^>]*itemprop=["']title["'][^>]*>([\s\S]*?)<\/h2>/);
    if(!id||!title)return null;
    const price=block.match(/<p>\s*<span>報酬<\/span>\s*[：:]([\s\S]*?)<\/p>/);
    const deadline=block.match(/itemprop=["']validThrough["']\s+content=["'](\d{4}-\d{2}-\d{2})["']/)?.[1]||'';
    const postedAt=block.match(/itemprop=["']datePosted["']\s+content=["'](\d{4}-\d{2}-\d{2})["']/)?.[1]||'';
    return {id:'mamaworks-'+id[1],title:cleanText_(title[1]),url:'https://mamaworks.jp/job/'+id[1],budget:price?cleanText_(price[1]).slice(0,150):'報酬は募集ページで確認',deadline,postedAt,status:'released',private:false,filterText:''};
  }).filter(Boolean);
}
function hasReferenceVideo_(description){
  // Examine the job description only. Preserve hrefs, which are absent from rendered link labels.
  const text=decodeHtml_(description)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,(_,url,label)=>cleanText_(label)+' '+decodeHtml_(url))
    .replace(/<br\s*\/?\s*>|<\/p>|<\/li>/gi,'\n').replace(/<[^>]*>/g,' ').normalize('NFKC');
  for(const match of text.matchAll(/https?:\/\/[^\s<>"'（）【】「」、。]+/g)){
    let url;try{url=new URL(match[0].replace(/[)\],;]+$/,''));}catch{continue;}
    const host=url.hostname.toLowerCase().replace(/^www\./,'');
    const isVideo=(host==='youtu.be'&&/^\/[\w-]{6,}(?:\/|$)/.test(url.pathname))||
      ((host==='youtube.com'||host==='m.youtube.com')&&((url.pathname==='/watch'&&/^[\w-]{6,}$/.test(url.searchParams.get('v')||''))||/^\/(?:shorts|embed)\/[\w-]{6,}/.test(url.pathname)))||
      (host==='vimeo.com'&&/^\/\d+/.test(url.pathname))||(host==='player.vimeo.com'&&/^\/video\/\d+/.test(url.pathname))||
      (host==='tiktok.com'&&/^\/@[^/]+\/video\/\d+/.test(url.pathname))||
      (['vt.tiktok.com','vm.tiktok.com'].includes(host)&&/^\/[\w-]+/.test(url.pathname))||
      (host==='instagram.com'&&/^\/reel\/[\w-]+/.test(url.pathname))||
      (host==='drive.google.com'&&(/^\/file\/d\/[\w-]+/.test(url.pathname)||(url.pathname==='/open'&&url.searchParams.has('id'))));
    if(!isVideo)continue;
    const context=text.slice(Math.max(0,match.index-180),match.index+match[0].length+70);
    if(/参考(?:動画|映像)|完成(?:イメージ|動画|例)|編集(?:イメージ|例)|動画(?:イメージ|例)|サンプル(?:動画|映像)|(?:以下|下記|このような).{0,15}動画/.test(context.replace(/\s+/g,'')))return true;
  }
  return false;
}
function parseCrowdworksDetail_(html){
  let posting;
  for(const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{const item=JSON.parse(match[1]);posting=([].concat(item['@graph']||item)).find(v=>v['@type']==='JobPosting');if(posting)break;}catch{}
  }
  if(!posting||typeof posting.description!=='string'||posting.description.length<20)throw new Error('募集本文を確認できません');
  const client=html.match(/id=["']client_detail_information_container["'][^>]*\bdata=["']([^"']+)["']/);
  if(!client)throw new Error('発注者を確認できません');
  const employer=JSON.parse(decodeHtml_(client[1]));
  if(!Number.isSafeInteger(employer.userId)||employer.userId<=0)throw new Error('発注者IDを確認できません');
  return {body:cleanText_(decodeHtml_(posting.description)),hasReferenceVideo:hasReferenceVideo_(posting.description),employerId:employer.userId,deadline:String(posting.validThrough||'').slice(0,10)};
}
function parseCrowdworksEmployer_(html){
  const data=html.match(/id=["']vue-container["'][^>]*\bdata=["']([^"']+)["']/);
  if(!data)throw new Error('発注実績を確認できません');
  const user=JSON.parse(decodeHtml_(data[1])).employer_profile_json?.employer_user;
  const ratingCount=user?.feedback?.total_count,contracts=user?.project_finished_data?.total_acceptance_count;
  if(!Number.isSafeInteger(ratingCount)||!Number.isSafeInteger(contracts))throw new Error('評価・契約件数を確認できません');
  return {ratingCount,contracts};
}
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
      const seen=new Set(),jobs=[],candidates=[];let rawCount=0;
      const excluded={};const countExcluded=reason=>{excluded[reason]=(excluded[reason]||0)+1;};
      const pages=source.id==='mamaworks'?1:JOB_SETTINGS.pages;
      for(let page=1;page<=pages;page++){
        const html=await fetchPage(source.url+(source.id==='mamaworks'?'':'&page='+page),fetcher);
        const parsed=source.id==='crowdworks'?parseCrowdworks_(html):source.id==='coconala'?parseCoconala_(html,now):source.id==='lancers'?parseLancers_(html,now):parseMamaworks_(html);
        if(!parsed.length&&page===1&&!hasEmptyResults_(html))throw new Error('案件一覧の形式を確認できませんでした');
        rawCount+=parsed.length;
        for(const job of parsed){if(seen.has(job.id))continue;seen.add(job.id);if(!eligibleJob_(job,now)||!JOB_URLS[source.id].test(job.url))continue;if(source.id==='crowdworks'){const reason=crowdworksExclusion(job.title,job.filterText);if(reason)countExcluded(reason);else candidates.push(job);}else jobs.push(job);}
        if(!parsed.length||parsed.length<(source.id==='coconala'?40:source.id==='lancers'?30:50))break;
        if(page<JOB_SETTINGS.pages)await pause(1500);
      }
      let detailChecked=0;
      if(source.id==='crowdworks'){
        const employers=new Map();let detailFailures=0;const deadline=Date.now()+180000;
        for(const job of candidates.slice(0,60)){
          if(Date.now()>deadline){countExcluded('not_checked');break;}
          await pause(600);
          try{
            const detail=parseCrowdworksDetail_(await fetchPage(job.url,fetcher));detailChecked++;
            const reason=crowdworksExclusion(job.title,detail.body);if(reason){countExcluded(reason);continue;}
            if(!detail.hasReferenceVideo){countExcluded('no_reference_video');continue;}
            if(detail.deadline&&detail.deadline<jstDay_(now)){countExcluded('expired');continue;}
            if(!employers.has(detail.employerId)){await pause(600);employers.set(detail.employerId,parseCrowdworksEmployer_(await fetchPage('https://crowdworks.jp/public/employers/'+detail.employerId,fetcher)));}
            const client=employers.get(detail.employerId);
            if(client.ratingCount<=0||client.contracts<=0){countExcluded('no_rating_or_contracts');continue;}
            jobs.push(job);
          }catch{detailFailures++;countExcluded('unverifiable');}
        }
        if(candidates.length&&detailChecked===0&&detailFailures)throw new Error('募集本文を確認できないため、未確認の案件は掲載していません');
        if(candidates.length>60)excluded.not_checked=(excluded.not_checked||0)+candidates.length-60;
      }
      jobs.sort((a,b)=>String(b.postedAt||'').localeCompare(String(a.postedAt||'')));
      sources.push({...source,jobs:jobs.slice(0,JOB_SETTINGS.maxJobsPerSource).map(publicJob_),lastSuccess:now.toISOString(),lastAttempt:now.toISOString(),error:null,rawCount,...(source.id==='crowdworks'?{screeningPolicy:CW_POLICY,detailChecked,excluded}:{} )});
    }catch(error){
      const reusable=source.id!=='crowdworks'||prior.screeningPolicy===CW_POLICY;
      sources.push({...source,jobs:reusable?(prior.jobs||[]).map(publicJob_):[],lastSuccess:reusable?prior.lastSuccess||null:null,lastAttempt:now.toISOString(),error:String(error.message||error).slice(0,180),...(source.id==='crowdworks'?{screeningPolicy:CW_POLICY}:{})});
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
module.exports={update,JOB_SETTINGS,parseCrowdworks_,parseCoconala_,parseLancers_,parseMamaworks_,parseCrowdworksDetail_,parseCrowdworksEmployer_,hasReferenceVideo_,crowdworksExclusion,CW_EXCLUDED_WORDS,CW_POLICY,eligibleJob_,publicJob_,fetchPage};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});

