export type UiLanguage = 'en' | 'ru';

const RU: Record<string, string> = {
  'This path':'Этот вариант','— what could make it fail':'— что может пойти не так','I want to make my decision':'Я хочу принять решение','I want to test something first':'Сначала хочу что-то проверить',
  'Your answers':'Ваши ответы','Saved. The next question is below. Your answers are taken into account when the possible paths are built.':'Сохранено. Следующий вопрос ниже. Ваши ответы учитываются при построении возможных вариантов.',
  'Loading…':'Загрузка…','Access password':'Пароль доступа','Enter the password for this deployment.':'Введите пароль для этого развёртывания.','Enter access password':'Введите пароль доступа','Sign in':'Войти','Retry':'Повторить','Delete this decision?':'Удалить это решение?','Nothing here yet':'Здесь пока ничего нет','Describe the situation in your own words — you do not need to structure it first.':'Опишите ситуацию своими словами — сначала структурировать её не нужно.','New decision':'Новое решение','Migration report':'Отчёт о переносе данных','Download archive of old data':'Скачать архив старых данных','Export all':'Экспортировать всё','Export':'Экспортировать','New':'Новый','History':'История','History not saved':'История не сохраняется','More':'Ещё','Google AI':'Google AI','Save to Drive':'Сохранить в Drive','Connect Drive':'Подключить Drive','Saving…':'Сохранение…','Simple mode':'Простой режим','Expert mode':'Экспертный режим','Brief':'Кратко','You are here':'Вы здесь','Completed':'Завершено','Next':'Далее','How to use this':'Как это использовать','Follow the highlighted step, answer the question on screen, then continue.':'Следуйте выделенному шагу, ответьте на вопрос на экране и продолжайте.','Detailed steps':'Подробные шаги','Human decision:':'Решение человека:','recorded':'зафиксировано','not yet':'ещё нет','Your decision, step by step':'Ваше решение — шаг за шагом','The analysis below is built from your conversation and the information already found.':'Ниже — анализ на основе вашего разговора и уже найденной информации.','Working…':'Обрабатываю…','EXPERT ANALYSIS':'ЭКСПЕРТНЫЙ АНАЛИЗ','CURRENT ANALYSIS':'ТЕКУЩИЙ АНАЛИЗ','THE DECISION':'РЕШЕНИЕ','What is still an assumption':'Что пока является предположением','Examples and hypothetical values':'Примеры и гипотетические значения','What may be an interpretation':'Что может быть интерпретацией','What matters to you':'Что для вас важно','What needs an outside check':'Что нужно проверить отдельно','Next useful actions':'Следующие полезные действия','Why:':'Почему:','What to measure:':'Что измерять:','What changes if the result is different:':'Что изменится при другом результате:','Open questions':'Открытые вопросы','How to find out:':'Как это выяснить:','Your answer, or leave it blank if you do not know':'Ваш ответ или оставьте поле пустым, если не знаете','Answer':'Ответить',"I don't know":'Не знаю','See the possible paths':'Посмотреть возможные варианты','Think out loud':'Рассказать вслух','Argue against my plan':'Поспорить с моим планом','Prepare for a conversation':'Подготовиться к разговору','What to find out first':'Что выяснить в первую очередь','Send':'Отправить','Next useful step: ':'Следующий полезный шаг: ','Next useful step:':'Следующий полезный шаг:','Read the full conversation':'Прочитать весь разговор','Write this up as a short note':'Оформить это как короткую заметку','Looking at your specific situation…':'Изучаю конкретно вашу ситуацию…','Looking at the specific facts and unknowns in your situation…':'Проверяю конкретные факты и неизвестные в вашей ситуации…','Safety and fit check':'Проверка безопасности и применимости','Yes':'Да','No':'Нет','Please pause.':'Пожалуйста, остановитесь.','Continue':'Продолжить','How do you want to start?':'С чего вы хотите начать?','This is only about personal values; there is nothing factual to check':'Это только вопрос личных ценностей; факты здесь проверять не нужно','Result:':'Результат:','Look beyond the obvious choices':'Посмотреть шире очевидных вариантов','Here are the main possibilities to keep on the table:':'Вот основные варианты, которые стоит оставить в рассмотрении:','Key assumption:':'Ключевое предположение:','If it is wrong:':'Если это окажется неверным:','Cheapest useful check:':'Самая дешёвая полезная проверка:','I have enough to decide':'Мне уже достаточно для решения','Let’s test what could go wrong':'Проверим, что может пойти не так','Show me the weak points':'Покажите слабые места','Concern:':'Проблема:','Hidden assumption:':'Скрытое предположение:','Failure mode:':'Сценарий сбоя:','What would make this concern weaker:':'Что сделало бы эту проблему менее существенной:','Experiment drafts':'Черновики экспериментов','Decision map':'Карта решения','Journal and learning':'Журнал и обучение','Decision Brief':'Краткая информация о решении','Final cost of error':'Итоговая цена ошибки','Cost of error (final)':'Цена ошибки (итоговая)','Reversibility (final)':'Обратимость (итоговая)','Final reversibility':'Итоговая обратимость','Validity threats':'Угрозы валидности','Forecast (human only)':'Прогноз (только человек)','EVPI (local calculation)':'EVPI (локальный расчёт)','Discrepancy type':'Тип расхождения','Data':'Данные','Assumption':'Предположение','Reasoning':'Рассуждение','Execution':'Исполнение','Chance':'Случайность','low':'низкая','medium':'средняя','high':'высокая','unknown':'неизвестно','yes':'да','no':'нет','two-way (can reverse)':'двустороннее (можно отменить)','one-way (costly to reverse)':'одностороннее (дорого отменить)','two-way door (can reverse)':'двустороннее решение (можно отменить)','one-way door (costly to reverse)':'одностороннее решение (дорого отменить)','Save':'Сохранить','Cancel':'Отмена','Preferred first model':'Предпочтительная первая модель','Gemini API key (optional)':'API-ключ Gemini (необязательно)','Server key:':'Ключ сервера:','configured':'настроен','not configured':'не настроен','Google AI settings saved.':'Настройки Google AI сохранены.','Copied to clipboard':'Скопировано в буфер обмена','Reason for shifting the threshold (required)':'Причина изменения порога (обязательно)','New stop threshold':'Новый порог остановки','Please write this up as a short note for me: what matters to me, what I do not know yet, and what I will find out this week.':'Оформите это как короткую заметку: что для меня важно, чего я пока не знаю и что я выясню на этой неделе.','If you are in immediate danger, contact a person near you or local emergency services first. You do not have to decide anything today.':'Если вам сейчас непосредственно угрожает опасность, сначала свяжитесь с близким человеком или местной экстренной службой. Вам не нужно принимать решение сегодня.','Do not use this decision tool in this state. If things improve, come back and answer “No”.':'Не используйте этот инструмент принятия решений в таком состоянии. Если ситуация улучшится, вернитесь и ответьте «Нет».','We have widened the decision beyond the original framing. These are possibilities to consider — not recommendations.':'Мы расширили решение за пределы исходной формулировки. Это варианты для рассмотрения, а не рекомендации.','The useful question now is not “which one wins?” but “what would we need to learn before one of these becomes clearly more or less workable?”':'Сейчас полезный вопрос не «какой вариант победит?», а «что нам нужно узнать, прежде чем станет ясно, насколько каждый из них работоспособен?»','We will stress-test the paths symmetrically. This is not a vote for or against any option.':'Мы симметрично проверим варианты на прочность. Это не голосование за или против какого-либо варианта.','You do not need to score or approve every objection. The point is simply to notice what deserves checking before you commit.':'Вам не нужно оценивать или одобрять каждое возражение. Важно заметить то, что стоит проверить до принятия решения.','You have seen the main possibilities and the main ways they could fail. I will not choose for you.':'Вы увидели основные варианты и основные способы, которыми они могут не сработать. Я не буду выбирать за вас.','Tell me, in plain language, what you are going to do now. It is also completely fine to postpone the decision or decide to gather one more fact first.':'Расскажите простыми словами, что вы собираетесь делать сейчас. Вполне нормально также отложить решение или сначала выяснить ещё один факт.'
};

// Files in the conversation: attaching, downloading, documents.
Object.assign(RU, {
  'Attach file': 'Прикрепить файл', 'Reading…': 'Читаю…', 'Preparing…': 'Готовлю…', 'Create a document': 'Создать документ',
  'Word (.docx)': 'Word (.docx)', 'Save as Word': 'Сохранить как Word', 'Save as PDF': 'Сохранить как PDF',
  'Conversation as Word': 'Разговор в Word', 'Conversation as PDF': 'Разговор в PDF',
  'Save to Google Docs': 'Сохранить в Google Docs', 'Saved to Google Drive.': 'Сохранено на Google Диск.', 'Open in Google Docs': 'Открыть в Google Docs',
  'Please prepare a document I can download: a clear summary of this conversation with what matters to me, what is not known yet and the next step.':
    'Подготовьте документ, который я смогу скачать: чёткое резюме этого разговора — что для меня важно, что пока неизвестно и каков следующий шаг.',
  // Stage 1 (v1.4.1)
  'File will be sent to Gemini': 'Файл будет отправлен в Gemini',
  'Copy': 'Копировать',
  'Copied': 'Скопировано',
  'Drop files to attach': 'Перетащите файлы сюда',
  'You can attach up to 5 files to one message.': 'К одному сообщению можно прикрепить не больше 5 файлов.',
  'The file could not be attached.': 'Не удалось прикрепить файл.',
  // Stage 2 (v1.4.2)
  'Add file': 'Добавить файл',
  'Save to file': 'Сохранить в файл',
  'From device': 'С устройства',
  'From program files': 'Из файлов программы',
  'What to save': 'Что сохранить',
  'Whole dialogue': 'Весь диалог',
  'Agent summary': 'Итог от агента',
  'Full decision review': 'Весь разбор решения',
  'Reminder calendar (.ics)': 'Календарь напоминаний (.ics)',
  'Format': 'Формат',
  '← Back': '← Назад',
  'Save…': 'Сохранить…',
  'Saved as Word.': 'Сохранено как Word.',
  'Saved as PDF.': 'Сохранено как PDF.',
  'Export all': 'Экспортировать всё',
  'Import': 'Импортировать',
  'Delete dialogue': 'Удалить диалог',
  'Drive connected': 'Drive подключён',
  'Syncing…': 'Синхронизация…',
  'No reply yet — try again': 'Ответа нет — повторите',
  'Requesting summary from the agent…': 'Запрашиваю итог у агента…',
  'Calendar downloaded.': 'Календарь скачан.',
  'Google sign-in is not configured.': 'Вход в Google не настроен.',
});

function translateText(value: string, language: UiLanguage): string {
  if (language !== 'ru') return value;
  if (RU[value] !== undefined) return RU[value];
  let m = value.match(/^Decision method · cycle (\d+)$/); if (m) return `Метод принятия решения · цикл ${m[1]}`;
  m = value.match(/^Imported: (\d+)$/); if (m) return `Импортировано: ${m[1]}`;
  return value;
}

export function detectUiLanguage(text: string): UiLanguage {
  const letters = (text.match(/[A-Za-zА-Яа-яЁё]/g) || []).length;
  const cyrillic = (text.match(/[А-Яа-яЁё]/g) || []).length;
  return letters > 0 && cyrillic / letters >= 0.15 ? 'ru' : 'en';
}
export function getStoredUiLanguage(): UiLanguage { try { return localStorage.getItem('bifurcation_ui_language') === 'ru' ? 'ru' : 'en'; } catch { return 'en'; } }
export function setStoredUiLanguage(language: UiLanguage) { try { localStorage.setItem('bifurcation_ui_language', language); } catch {} }

export function installUiLanguage(language: UiLanguage): () => void {
  const apply = () => {
    if (!document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) nodes.push(node as Text);
    for (const textNode of nodes) {
      const parent = textNode.parentElement;
      if (!parent || ['SCRIPT','STYLE','TEXTAREA'].includes(parent.tagName)) continue;
      const raw = textNode.nodeValue || ''; const trimmed = raw.trim(); if (!trimmed) continue;
      const translated = translateText(trimmed, language);
      if (translated !== trimmed) {
        const at = raw.indexOf(trimmed); textNode.nodeValue = raw.slice(0, at) + translated + raw.slice(at + trimmed.length);
      }
    }
    const els = document.body.querySelectorAll('[placeholder],[title],[aria-label]');
    els.forEach((el) => ['placeholder','title','aria-label'].forEach((attr) => { const v=el.getAttribute(attr); if(v){const t=translateText(v,language); if(t!==v) el.setAttribute(attr,t);} }));
  };
  let applying = false;
  const guarded = () => { if (applying) return; applying = true; try { apply(); } finally { applying = false; } };
  guarded();
  const observer = new MutationObserver(guarded);
  observer.observe(document.body, { childList:true, subtree:true, characterData:true });
  return () => observer.disconnect();
}
