// Keyword scorer: first pass over every post. Decides obvious cases instantly
// and marks the rest "ambiguous" so they get sent to the LLM.
// Plain script (not a module) so it can run as a content script and in Node tests.
(function (root) {
  const LIF = (root.LIF = root.LIF || {});

  const AR_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;

  // NFKC also folds LinkedIn's "fancy" unicode bold/italic text (𝗛𝗶𝗿𝗶𝗻𝗴 → hiring)
  // and Arabic presentation forms back to plain letters.
  function normalize(text) {
    return text
      .normalize('NFKC')
      .toLowerCase()
      .replace(AR_DIACRITICS, '')
      .replace(/ـ/g, '') // tatweel
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/ؤ/g, 'و')
      .replace(/ئ/g, 'ي')
      .replace(/[’‘`]/g, "'")
      .replace(/_/g, ' ') // Arabic hashtags: #فرص_عمل
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isMostlyArabic(text) {
    const arabic = (text.match(/[؀-ۿ]/g) || []).length;
    const latin = (text.match(/[a-zA-Z]/g) || []).length;
    return arabic > latin;
  }

  // [side, category, weight, ...patterns]
  // RegExp patterns run against normalized text (English).
  // String patterns are Arabic; they're normalized and substring-matched, since
  // Arabic attaches prefixes (و، ال، ب، ل) that break word boundaries.
  const RULES = [
    // ---------- KEEP: opportunity ----------
    ['keep', 'opportunity', 4,
      /\bwe('re| are)( actively)? hiring\b/, /\bnow hiring\b/, /#hiring\b/,
      /\bsend (your|us your|me your) (cv|resume|résumé|portfolio)/,
      /\bapplications? (are )?(now )?open\b/,
      /\bcall for (applications|papers|proposals|speakers|submissions)\b/,
      /\bjob (opening|vacanc)/, /\bopen (position|role|vacanc)/, /\bvacanc(y|ies)\b/,
      'نحن نوظف', 'وظيفة شاغرة', 'وظائف شاغرة', 'شواغر', 'فرصة وظيفية', 'فرص وظيفية',
      'فرصة عمل', 'فرص عمل', 'مطلوب موظف', 'أرسل سيرتك', 'إرسال السيرة الذاتية',
      'أرسلوا السيرة', 'باب التقديم', 'رابط التقديم', 'للتقديم', 'قدم الآن',
      'التقديم متاح', 'انضم إلى فريقنا', 'انضم لفريقنا', 'انضموا إلى فريقنا'],
    ['keep', 'opportunity', 3,
      /\b(is|are) hiring\b/, /\bjoin (our|my) (growing )?team\b/,
      /\blooking for (a|an)\b.{0,40}\b(engineer|developer|designer|manager|intern|analyst|specialist|lead|scientist|consultant|writer|marketer|accountant|recruiter)s?\b/,
      /\b(apply|applications?) (here|now|today|via|through|at|using|before|by)\b/,
      /\binternship (opportunit|program|position|opening)/,
      /\bfreelance (gig|project|opportunit)/,
      /\b(full|part)[- ]time (role|position|job)\b/, /\bremote (role|position|job)\b/,
      'نوظف', 'توظيف', 'شاغر', 'منحة دراسية', 'منح دراسية', 'تدريب تعاوني',
      'تدريب صيفي', 'برنامج تدريب', 'تدريب منتهي بالتوظيف',
      // dialect
      'بندور على', 'اللي مهتم يبعت', 'ابعتلي الcv', 'ابعتلي ال cv'],
    ['keep', 'opportunity', 2,
      /\b(scholarship|fellowship)s?\b/, /\bdm me if (you're |you are )?interested\b/,
      'مطلوب', 'نبحث عن', 'محتاجين'],
    ['keep', 'opportunity', 1,
      /\bhiring\b/, /\bapply\b/, /\bopportunit(y|ies)\b/, /\binternships?\b/, /\bgrants?\b/, /\bcv\b/,
      'فرصة', 'وظيفة', 'تقديم', 'منحة'],

    // ---------- KEEP: event ----------
    ['keep', 'event', 4,
      /\bsave the date\b/, /\bregistration (is )?(now )?open\b/,
      /\bregister (now|here|today|via|at|for free)\b/, /\brsvp\b/,
      /\bjoin us (on|at|for|this|next|live)\b/,
      'سجل الآن', 'سجلوا الآن', 'رابط التسجيل', 'التسجيل متاح', 'باب التسجيل',
      'يسرنا دعوتكم', 'ندعوكم', 'احجز مقعدك', 'احجزوا مقاعدكم'],
    ['keep', 'event', 3,
      /\bwebinar\b/, /\bhackathon\b/, /\bmeetup\b/, /\blive session\b/,
      /\b(free|limited) (seats|spots)\b/, /\bsign up (now|here|today)\b/,
      'ورشة عمل', 'ندوة', 'ويبينار', 'ويبنار', 'هاكاثون', 'لقاء مباشر', 'بث مباشر',
      'ملتقى', 'مؤتمر', 'مقاعد محدودة'],
    ['keep', 'event', 2,
      /\bworkshop\b/, /\bconference\b/, /\bsummit\b/, /\bbootcamp\b/, /\bdeadline\b/,
      'فعالية', 'معرض', 'آخر موعد', 'موعد التسجيل'],
    ['keep', 'event', 1,
      /\bevents?\b/, /\bregister\b/, /\btickets?\b/,
      'التسجيل', 'حضور'],

    // ---------- KEEP: offer ----------
    ['keep', 'offer', 3,
      /\bpromo code\b/, /\bcoupon\b/, /\bdiscount code\b/, /\b\d{1,2}% off\b/, /\bgiveaway\b/,
      /\blimited[- ]time offer\b/,
      /\bfree (access|course|trial|ebook|e-book|template|resources?|tickets?|certificat)/,
      'كود خصم', 'كوبون', 'خصم', 'لفترة محدودة', 'سحب على', 'اشتراك مجاني'],
    ['keep', 'offer', 2,
      /\bdiscount\b/,
      'عرض خاص', 'مجانا', 'مجانية', 'مجاني', 'مسابقة', 'دورة مجانية'],
    ['keep', 'offer', 1,
      /\bfree\b/, /\boffer\b/],

    // ---------- HIDE: advice ----------
    ['hide', 'advice', 3,
      /\b\d+ (tips|ways|things|lessons|mistakes|habits|reasons|rules|signs|steps|truths|secrets)\b/,
      /\blessons? (i('ve)? )?learned\b/, /\bhere'?s (what|how|why)\b/, /\bunpopular opinion\b/,
      /\bhot take\b/, /\bnobody (tells|talks)\b/, /\bthe truth about\b/,
      /\bstop (doing|saying|using)\b/, /\bpro tip\b/,
      'نصائح', 'نصيحة', 'نصايح', 'أسرار', 'دروس تعلمتها', 'تعلمت', 'رأيي الشخصي',
      'من وجهة نظري', 'لا تستسلم', 'كيف تصبح', 'كيف تحصل', 'أخطاء'],
    ['hide', 'advice', 2,
      /\btips?\b/, /\badvice\b/, /\bhow to\b/, /\bmindset\b/, /\bmotivation(al)?\b/,
      /\bremember:/, /\breminder:/, /\bagree\?/, /\bthoughts\?/, /\bwhat do you think\b/,
      /\bsuccess is\b/, /\bleadership is\b/, /\bif you('re| are) (a|an|not|still)\b/,
      /\byour (career|network|personal brand)\b/,
      'نصيحتي', 'تذكر', 'النجاح', 'تحفيز', 'ما رأيكم', 'شاركوني', 'هل توافق', 'الفرق بين', 'كيف ت',
      // dialect
      'بقولك', 'خلي بالك', 'خليك', 'لازم تعرف', 'متخليش', 'يا جماعة', 'ودي أقول'],

    // ---------- HIDE: story ----------
    ['hide', 'story', 3,
      /\bi('m| am) (so |very )?(happy|excited|thrilled|pleased|proud|delighted|humbled) to (share|announce)\b/,
      /\bstarting a new position\b/, /\bmy (journey|story)\b/, /\bstory ?time\b/,
      /\byears ago,? i\b/, /\bi (still )?remember (when|the day)\b/,
      /#opentowork\b/, /\bopen to work\b/,
      /\bi('ve| have)? (been|was|got) (laid off|let go)\b/,
      'يسعدني أن أعلن', 'يسعدني مشاركتكم', 'سعيد أن أشارككم', 'سعيدة أن أشارككم',
      'بدأت العمل', 'بدأت عملي', 'انضممت', 'تم قبولي', 'تخرجت', 'قصتي', 'رحلتي', 'تجربتي'],
    ['hide', 'story', 2,
      /\bgrateful\b/, /\bhumbled\b/, /\bcongratulations\b/, /\bcongrats\b/, /\bproud (of|to)\b/,
      /\bthank you (all|everyone)\b/, /\bmilestone\b/, /\bgraduated\b/, /\banniversary\b/,
      /\bcertified\b/,
      'الحمد لله', 'ممتن', 'شكرا لكل', 'فخور', 'فخورة', 'مبروك', 'تهانينا', 'حصلت على'],

    // ---------- HIDE: complaint ----------
    ['hide', 'complaint', 3,
      /\brant\b/, /\bghost(ed|ing)\b/, /\bfed up\b/, /\bsick of\b/, /\bunacceptable\b/,
      /\btoxic\b/, /\bwhy do (companies|recruiters|hr)\b/,
      /\bdear (recruiters|hr|companies|hiring managers)\b/,
      'للأسف', 'مع الأسف', 'تم رفضي', 'محبط', 'ظلم'],
    ['hide', 'complaint', 2,
      /\bfrustrat/, /\bdisappoint/, /\bburn(ed|t)? ?out\b/, /\brejected\b/, /\brejection\b/,
      /\blayoffs?\b/, /\bunpaid\b/, /\bexploit/,
      'بصراحة', 'تجاهل', 'استغلال', 'تسريح',
      // dialect
      'السوق مش', 'محدش', 'ليه الشركات', 'الشركات بقت'],
  ];

  // Pre-normalize Arabic patterns once so they match normalized post text.
  const COMPILED = RULES.map(([side, category, weight, ...patterns]) => ({
    side,
    category,
    weight,
    patterns: patterns.map((p) => (typeof p === 'string' ? normalize(p) : p)),
  }));

  function decide(keep, hide) {
    if (keep >= 3 && hide <= 1) return 'keep';
    if (hide >= 3 && keep <= 1) return 'hide';
    if (keep >= 6 && hide <= 2) return 'keep';
    if (hide >= 6 && keep <= 2) return 'hide';
    return 'ambiguous';
  }

  function classify(rawText) {
    const text = normalize(rawText || '');
    const scores = { keep: 0, hide: 0 };
    const catScores = {};
    const matches = [];

    for (const rule of COMPILED) {
      for (const p of rule.patterns) {
        const hit = typeof p === 'string' ? text.includes(p) : p.test(text);
        if (!hit) continue;
        scores[rule.side] += rule.weight;
        catScores[rule.category] = (catScores[rule.category] || 0) + rule.weight;
        matches.push(String(p));
      }
    }

    const verdict = decide(scores.keep, scores.hide);
    const lean = scores.keep > scores.hide ? 'keep' : scores.hide > scores.keep ? 'hide' : null;
    const side = verdict === 'ambiguous' ? lean : verdict;
    let category = null;
    if (side) {
      const sideCats = COMPILED.filter((r) => r.side === side).map((r) => r.category);
      category = Object.keys(catScores)
        .filter((c) => sideCats.includes(c))
        .sort((a, b) => catScores[b] - catScores[a])[0] || null;
    }

    return { verdict, lean, category, keepScore: scores.keep, hideScore: scores.hide, matches };
  }

  LIF.keywords = { normalize, classify, isMostlyArabic };
})(globalThis);