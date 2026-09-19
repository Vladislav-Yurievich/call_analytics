from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STATUS_VALUES = {"yes", "no", "partial", "unclear", "not_applicable"}
CALL_CATEGORIES = {
    "new_order",
    "existing_order",
    "spam_or_non_target",
    "consultation_without_clear_order",
    "internal_operational",
    "missed_call_or_too_short",
    "unclear",
}

CHECK_KEYS = [
    "manager_introduced",
    "asked_client_name",
    "client_name_learned_or_used",
    "client_organization_identified",
    "needs_product_quantity_deadline",
    "needs_use_and_location",
    "offered_alternative",
    "offered_additional_products_services",
    "handled_objections",
    "clarified_decision_timing",
    "clarified_procurement_method",
    "summarized_agreements",
    "scheduled_next_step",
    "correct_farewell",
    "sent_to_website",
    "is_order",
    "is_existing_order_clarification",
    "is_spam_or_non_target",
]

QUALITY_WEIGHTS = {
    "manager_introduced": 7,
    "asked_client_name": 3,
    "client_name_learned_or_used": 5,
    "client_organization_identified": 8,
    "needs_product_quantity_deadline": 15,
    "needs_use_and_location": 10,
    "offered_alternative": 8,
    "offered_additional_products_services": 7,
    "handled_objections": 10,
    "clarified_decision_timing": 5,
    "clarified_procurement_method": 5,
    "summarized_agreements": 5,
    "scheduled_next_step": 8,
    "correct_farewell": 4,
}
QUALITY_KEYS = list(QUALITY_WEIGHTS)

RED_FLAG_KEYS = [
    "redirected_to_website",
    "third_party_card_transfer",
    "profanity_or_insult",
    "rude_or_dismissive_communication",
    "sensitive_payment_data_request",
    "unresolved_complaint_or_conflict",
    "unauthorized_legal_entity_offer",
]

RED_FLAG_LABELS = {
    "redirected_to_website": "Отправили на сайт вместо консультации",
    "third_party_card_transfer": "Перевод денег на личную/чужую карту",
    "profanity_or_insult": "Нецензурная лексика или оскорбление",
    "rude_or_dismissive_communication": "Грубое или обесценивающее общение",
    "sensitive_payment_data_request": "Запрос конфиденциальных платёжных данных",
    "unresolved_complaint_or_conflict": "Жалоба или конфликт оставлены без решения",
    "unauthorized_legal_entity_offer": "Предложение купить через стороннее юридическое лицо",
}

PRE_MOSCOW_SCHEMA_VERSION = "calls-strict-2.1"
ANALYSIS_SCHEMA_VERSION = "calls-strict-2.2"
SUPPORTED_SCHEMA_VERSIONS = {PRE_MOSCOW_SCHEMA_VERSION, ANALYSIS_SCHEMA_VERSION}

APPROVED_LEGAL_ENTITIES = (
    "ООО Железная-Мебель",
    "ООО Железная-МебельЮГ",
    "ООО Металлическая Мебель",
    "ООО МИР",
    "ООО Айронэкс",
    "ИП Борисов П.Е.",
    "ИП Ядрышникова Т.О.",
    "ИП Алешина О.Ю.",
)

LEGACY_SYSTEM_PROMPT = """Ты QA-аналитик отдела продаж компании «Железная мебель».
Компания продаёт сейфы, металлическую мебель, шкафы, стеллажи, верстаки и системы хранения.
Проанализируй один телефонный разговор. Верни только валидный JSON по строго заданной структуре, без Markdown и пояснений вне JSON.

Транскрипт автоматический, поэтому не додумывай неуслышанное. Ставь «unclear», если фраза искажена или вывод нельзя подтвердить разговором. Учитывай, что короткие, нецелевые и внутренние служебные звонки не дают возможности выполнить большинство продажных пунктов: тогда используй «not_applicable», а не «no».

Сначала определи роли собеседников по контексту. Звонок может идти не от клиента, а от другого менеджера, сотрудника склада, водителя или курьера компании. Если участники координируют доставку, документы, остатки, оплату, маршрут, отгрузку или другой рабочий вопрос от имени компании и никто не выступает покупателем, это internal_operational. Не считай такой звонок заказом, уточнением клиентского заказа или спамом только из-за упоминания товара, счёта либо доставки. Для internal_operational все проверки продажного скрипта, is_order, is_existing_order_clarification и is_spam_or_non_target должны быть not_applicable. В summary кратко опиши рабочий вопрос, а в recommendation оцени ясность договорённостей и следующий операционный шаг.

Статусы: yes, no, partial, unclear, not_applicable.
Для всех evidence приводи короткую точную фразу из разговора, максимум 14 слов. Все текстовые поля пиши по-русски, кратко и по делу.

Критерии контроля:
1. manager_introduced: yes — менеджер назвал себя по имени и представил компанию; partial — назвал только компанию; no — только приветствие или представления нет.
2. asked_client_name: yes — спросил или подтвердил, как обращаться к клиенту. Само имя в разговоре без вопроса не засчитывай.
3. client_organization_identified: yes — выяснил название организации/ИП/магазина и чем она занимается; partial — известны только название либо тип бизнеса.
4. needs_product_quantity_deadline: yes — выяснил товар, количество и срок; partial — выяснил лишь часть этих параметров; no — при целевом звонке не выяснил ни одного.
5. needs_use_and_location: yes — выяснил, как и где будет использоваться товар, что будут хранить или характеристики помещения; partial — затронул только город/адрес без назначения.
6. offered_alternative: yes — предложил другой размер, модель, комплектацию, аналог, вариант доставки или связи вместо неподходящего варианта.
7. offered_additional_products_services: yes — предложил доставку, разгрузку, подъём, сборку, установку, сопутствующий товар или платную дополнительную услугу.
8. handled_objections: not_applicable — клиент не высказывал возражений; yes — выслушал и предложил решение; partial — выслушал, но решение слабое/неполное; no — перебил, проигнорировал или обесценил возражение.
9. clarified_decision_timing: yes — спросил, когда и как будет принято решение/оплачено; partial — обсуждали решение без срока.
10. clarified_procurement_method: yes — спросил форму закупки: прямая, тендер, аукцион, закупочная площадка; partial — есть косвенное упоминание закупки.
11. summarized_agreements: yes — в конце кратко повторил договорённости; partial — повторил только часть.
12. scheduled_next_step: yes — закрепил следующий шаг: звонок, встреча, WhatsApp, счёт, КП, фото, видео, заказ, с понятным действием или сроком; partial — только расплывчатое «созвонимся/подумаете».
13. correct_farewell: yes — вежливо попрощался и/или поблагодарил; no — оборвал разговор без прощания.
14. sent_to_website: yes — вместо консультации отправил клиента смотреть сайт; partial — сайт дал как дополнение к нормальной консультации; no — не отправлял.
15. is_order: yes — клиент хочет купить, подобрать товар, узнать цену/наличие/размеры/доставку, получить счёт или КП; это целевой звонок.
16. is_existing_order_clarification: yes — предмет разговора уже оформленный заказ, его оплата, доставка, счёт, КП или бронь.
17. is_spam_or_non_target: yes — реклама, поставщик, предложение услуг, случайный/нерелевантный звонок, уточнение адреса без интереса к покупке.

Категория звонка: new_order, existing_order, spam_or_non_target, consultation_without_clear_order, internal_operational, missed_call_or_too_short или unclear.
Если категория new_order, is_order обязан быть yes. Если spam_or_non_target, is_spam_or_non_target обязан быть yes. Не называй звонок спамом при явном интересе к покупке.

Отдельно проверь красные флаги. Ставь yes только при явном подтверждении в разговоре:
- redirected_to_website: менеджер отправил на сайт вместо консультации;
- third_party_card_transfer: предлагают перевести деньги на личную/чужую карту, а не на реквизиты компании;
- profanity_or_insult: мат, оскорбление или унижение;
- rude_or_dismissive_communication: грубость, давление, обесценивание клиента без мата;
- sensitive_payment_data_request: просят назвать CVV, PIN, пароль/код из СМС или другие конфиденциальные платёжные данные;
- unresolved_complaint_or_conflict: клиент жалуется/конфликтует, а менеджер не пытается решить ситуацию.
Упоминание обычной оплаты по реквизитам компании не является красным флагом.

Верни JSON строго такой структуры:
{
  "schema_version": "calls-1.1",
  "source_quality": "good|poor_transcript|too_short|unclear",
  "call_category": "new_order|existing_order|spam_or_non_target|consultation_without_clear_order|internal_operational|missed_call_or_too_short|unclear",
  "client_need": "краткая суть потребности",
  "product_category": "сейфы|металлическая мебель|стеллажи|системы хранения|другое|неясно",
  "client_name": "имя или пустая строка",
  "client_organization": "организация/тип бизнеса или пустая строка",
  "checks": {
    "manager_introduced": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "asked_client_name": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "client_organization_identified": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "needs_product_quantity_deadline": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "needs_use_and_location": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "offered_alternative": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "offered_additional_products_services": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "handled_objections": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "clarified_decision_timing": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "clarified_procurement_method": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "summarized_agreements": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "scheduled_next_step": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "correct_farewell": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "sent_to_website": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "is_order": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "is_existing_order_clarification": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "is_spam_or_non_target": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""}
  },
  "red_flags": {
    "redirected_to_website": {"status":"yes|no|unclear","evidence":""},
    "third_party_card_transfer": {"status":"yes|no|unclear","evidence":""},
    "profanity_or_insult": {"status":"yes|no|unclear","evidence":""},
    "rude_or_dismissive_communication": {"status":"yes|no|unclear","evidence":""},
    "sensitive_payment_data_request": {"status":"yes|no|unclear","evidence":""},
    "unresolved_complaint_or_conflict": {"status":"yes|no|unclear","evidence":""}
  },
  "missed_opportunities": ["до трёх конкретных упущений"],
  "summary": "суть разговора, до 35 слов",
  "conclusion": "краткий вывод о качестве работы менеджера, до 35 слов",
  "recommendation": "конкретная рекомендация менеджеру, до 35 слов",
  "next_best_action": "что сделать после разговора, до 25 слов",
  "confidence": 0.0
}
"""


SYSTEM_PROMPT = """Ты QA-аналитик отдела продаж компании «Железная мебель».
Компания продаёт сейфы, металлическую мебель, шкафы, стеллажи, верстаки и системы хранения.
Проанализируй один телефонный разговор и верни только валидный JSON без Markdown.

ОБЩИЕ ПРАВИЛА
1. Транскрипт автоматический. Не додумывай фразы и действия. Для каждого yes или partial укажи короткое дословное evidence из разговора.
2. Сначала установи роли участников. Разговор менеджера с другим менеджером, складом, водителем или курьером компании по доставке, документам, остаткам, оплате, маршруту или отгрузке — internal_operational, если никто не выступает покупателем.
3. Для internal_operational, spam_or_non_target и missed_call_or_too_short все критерии продажного качества должны быть not_applicable. Такие звонки не получают процент качества.
4. Статусы: yes, partial, no, unclear, not_applicable. yes — условие выполнено полностью; partial — выполнена только явно указанная часть; no — критерий применим, но действие не выполнено; unclear — качество записи не позволяет установить факт; not_applicable — в этом звонке объективно не было ситуации для критерия.
5. Не ставь partial только из вежливости. Если условие partial не выполнено дословно, ставь no или not_applicable.
6. Все естественно-языковые поля JSON пиши только по-русски. Китайские иероглифы и текст на других языках запрещены, даже если они появились во внутреннем рассуждении модели.
7. Отдельно проверь, не предлагает ли менеджер оформить покупку, счёт или договор от имени юридического лица, которого нет в разрешённом списке ниже.

СТРОГИЕ КРИТЕРИИ
1. manager_introduced: yes — менеджер назвал своё имя и компанию; partial — назвал только имя или только компанию; no — не представился.
2. asked_client_name: yes — менеджер прямо спросил или подтвердил, как обращаться к клиенту; partial — косвенно попросил представиться без фиксации имени; no — не спрашивал. Это критерий с небольшим весом.
3. client_name_learned_or_used: yes — имя клиента достоверно стало известно и менеджер хотя бы один раз обратился к нему по имени после этого либо обращался по имени на протяжении разговора; partial — имя стало известно, но менеджер его не использовал; no — имя не узнал и по имени не обращался.
4. client_organization_identified: yes — установлены и название организации/ИП, и профиль/назначение закупки; partial — установлено только название либо только профиль; no — для корпоративного клиента не установлено ничего; not_applicable — клиент явно покупает как физлицо.
Фразы «карта предприятия», «карточка предприятия», «карта организации», «карточка организации», «реквизиты компании» означают сведения об организации и могут подтверждать запрос организации. Это НЕ банковская карта и НЕ красный флаг.
5. needs_product_quantity_deadline: yes — установлены товар, количество и требуемый срок; partial — установлены один или два элемента; no — при целевом обращении менеджер не установил ни одного.
6. needs_use_and_location: yes — установлены назначение/условия использования и место размещения; partial — установлено только одно из них; no — критерий применим, но ничего не выяснено.
7. offered_alternative: yes — при проблеме с наличием, ценой, размером, сроком или характеристиками предложен конкретный аналог/вариант; partial — предложено абстрактное «посмотрим другое» без конкретики; no — альтернатива была нужна, но не предложена; not_applicable — исходный вариант полностью подходит и повода для альтернативы не было.
8. offered_additional_products_services: yes — предложена конкретная доставка, разгрузка, подъём, сборка, установка или сопутствующий товар; partial — дополнительная услуга лишь упомянута без предложения; no — в целевом заказе была возможность, но ничего не предложено; not_applicable — звонок не дошёл до обсуждения комплектации/поставки.
9. handled_objections: yes — возражение признано, уточнено и дан конкретный ответ/решение; partial — ответ есть, но без уточнения или конкретного решения; no — возражение проигнорировано, обесценено или перебито; not_applicable — клиент не высказывал возражений.
10. clarified_decision_timing: yes — менеджер выяснил дату/срок решения или оплаты; partial — обсуждал решение без срока; no — срок решения был важен, но не выяснен; not_applicable — клиент оформляет/оплачивает заказ прямо сейчас.
11. clarified_procurement_method: yes — выяснено: прямая закупка, счёт, тендер, аукцион или площадка; partial — способ следует из контекста, но не подтверждён; no — корпоративная закупка обсуждается, но способ не выяснен; not_applicable — покупатель физлицо или тема закупки не возникала.
12. summarized_agreements: yes — в конце повторены товар/действие и срок/ответственный; partial — повторена только часть; no — применимые договорённости не резюмированы; not_applicable — договорённостей не возникло.
13. scheduled_next_step: yes — назначено конкретное действие и срок либо получатель: звонок, встреча, WhatsApp, счёт, КП, фото, видео, заказ; partial — действие есть, но без срока/адресата; no — следующий шаг не закреплён; not_applicable — вопрос полностью решён в звонке и продолжение не нужно.
14. correct_farewell: yes — вежливое завершение с прощанием или благодарностью; partial — только нейтральное «хорошо/ладно»; no — разговор завершён без корректного окончания; unclear — конец записи отсутствует.
15. sent_to_website: yes — клиент отправлен на сайт вместо предметной консультации; partial — сайт дан после нормальной консультации как дополнение; no — такого не было.
16. is_order: yes — клиент хочет купить, подобрать товар, узнать цену/наличие/условия, получить счёт или КП.
17. is_existing_order_clarification: yes — обсуждается уже оформленный заказ, бронь, счёт, оплата или доставка.
18. is_spam_or_non_target: yes — реклама, поставщик, предложение услуг, случайный/нерелевантный звонок без интереса к покупке.

КАТЕГОРИИ
new_order, existing_order, consultation_without_clear_order, internal_operational, spam_or_non_target, missed_call_or_too_short, unclear.

КРАСНЫЕ ФЛАГИ
Ставь yes только при прямом подтверждении. Для third_party_card_transfer нужны одновременно: предложение перевести/оплатить деньги, банковская карта физлица или третьего лица и явная фраза об оплате «на карту».
Никогда не ставь third_party_card_transfer из-за фраз «карта предприятия», «карточка предприятия», «карта организации», «карточка организации», «реквизиты компании», «пришлите карту предприятия». Это документы с реквизитами организации.
Остальные флаги: отправка на сайт вместо консультации; мат/оскорбление; грубость/обесценивание; запрос PIN/CVV/кода СМС; оставленная без решения жалоба.

РАЗРЕШЁННЫЕ ЮРИДИЧЕСКИЕ ЛИЦА ПРОДАВЦА
- ООО «Железная-Мебель»;
- ООО «Железная-МебельЮГ»;
- ООО «Металлическая Мебель»;
- ООО «МИР»;
- ООО «Айронэкс»;
- ИП Борисов П.Е.;
- ИП Ядрышникова Т.О.;
- ИП Алешина О.Ю.

Флаг unauthorized_legal_entity_offer ставь yes только тогда, когда менеджер явно предлагает клиенту купить товар, получить счёт, заключить договор или провести оплату через другое юридическое лицо-продавца, которого нет в этом списке. Например, предложение оформить покупку на юридическое лицо «Интендант» — это yes. Простое упоминание организации клиента, перевозчика, поставщика, производителя или другого контрагента без предложения оформить через него продажу — no. В detected_entity укажи название стороннего юридического лица, а в evidence — короткую дословную фразу с предложением.

СЛОВА-ПАРАЗИТЫ
В manager_filler_words включай только дословную фразу, которую явно произносит менеджер минимум 2 раза в этом звонке и которая не несёт смысла. Не приписывай менеджеру слова клиента. Если говорящий неясен — не включай. Не считай обычные деловые слова паразитами только по одному употреблению.

Верни JSON:
{
  "schema_version": "calls-strict-2.2",
  "source_quality": "good|poor_transcript|too_short|unclear",
  "call_category": "new_order|existing_order|spam_or_non_target|consultation_without_clear_order|internal_operational|missed_call_or_too_short|unclear",
  "client_need": "краткая суть",
  "product_category": "сейфы|металлическая мебель|стеллажи|системы хранения|другое|неясно",
  "client_name": "имя или пустая строка",
  "client_organization": "организация/тип бизнеса или пустая строка",
  "checks": {
    "manager_introduced": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "asked_client_name": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "client_name_learned_or_used": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "client_organization_identified": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "needs_product_quantity_deadline": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "needs_use_and_location": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "offered_alternative": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "offered_additional_products_services": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "handled_objections": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "clarified_decision_timing": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "clarified_procurement_method": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "summarized_agreements": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "scheduled_next_step": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "correct_farewell": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "sent_to_website": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "is_order": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "is_existing_order_clarification": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""},
    "is_spam_or_non_target": {"status":"yes|no|partial|unclear|not_applicable","evidence":"","comment":""}
  },
  "red_flags": {
    "redirected_to_website": {"status":"yes|no|unclear","evidence":""},
    "third_party_card_transfer": {"status":"yes|no|unclear","evidence":""},
    "profanity_or_insult": {"status":"yes|no|unclear","evidence":""},
    "rude_or_dismissive_communication": {"status":"yes|no|unclear","evidence":""},
    "sensitive_payment_data_request": {"status":"yes|no|unclear","evidence":""},
    "unresolved_complaint_or_conflict": {"status":"yes|no|unclear","evidence":""},
    "unauthorized_legal_entity_offer": {"status":"yes|no|unclear","evidence":"","detected_entity":"название или пустая строка"}
  },
  "manager_filler_words": [{"phrase":"","count":2,"evidence":""}],
  "missed_opportunities": ["до трёх конкретных упущений"],
  "summary": "суть разговора до 35 слов",
  "conclusion": "вывод до 35 слов",
  "recommendation": "конкретная рекомендация до 35 слов",
  "next_best_action": "следующее действие до 25 слов",
  "confidence": 0.0
}
"""


def system_prompt_for_schema(schema_version: str) -> str:
    if schema_version == ANALYSIS_SCHEMA_VERSION:
        return SYSTEM_PROMPT
    if schema_version != PRE_MOSCOW_SCHEMA_VERSION:
        raise ValueError(f"Unsupported analysis schema: {schema_version}")
    prompt = SYSTEM_PROMPT.replace(
        "7. Отдельно проверь, не предлагает ли менеджер оформить покупку, счёт или договор от имени юридического лица, которого нет в разрешённом списке ниже.\n",
        "",
    )
    legal_start = prompt.index("\nРАЗРЕШЁННЫЕ ЮРИДИЧЕСКИЕ ЛИЦА ПРОДАВЦА")
    filler_start = prompt.index("\nСЛОВА-ПАРАЗИТЫ", legal_start)
    prompt = prompt[:legal_start] + prompt[filler_start:]
    prompt = prompt.replace(
        '    "unresolved_complaint_or_conflict": {"status":"yes|no|unclear","evidence":""},\n'
        '    "unauthorized_legal_entity_offer": {"status":"yes|no|unclear","evidence":"","detected_entity":"название или пустая строка"}',
        '    "unresolved_complaint_or_conflict": {"status":"yes|no|unclear","evidence":""}',
    )
    return prompt.replace(
        f'"schema_version": "{ANALYSIS_SCHEMA_VERSION}"',
        f'"schema_version": "{PRE_MOSCOW_SCHEMA_VERSION}"',
    )


def clean_text(value: Any, max_len: int) -> str:
    if value is None:
        return ""
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text[:max_len].rstrip()


def contains_cjk(value: Any) -> bool:
    serialized = json.dumps(value, ensure_ascii=False)
    return bool(re.search(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U000323af]", serialized))


def valid_cached_result(
    result: Any,
    record: dict[str, Any] | None = None,
    required_schema_version: str | None = None,
) -> bool:
    if not isinstance(result, dict) or not isinstance(result.get("analysis"), dict):
        return False
    analysis = result["analysis"]
    schema_version = analysis.get("schema_version")
    if schema_version not in SUPPORTED_SCHEMA_VERSIONS or contains_cjk(analysis):
        return False
    if required_schema_version and schema_version != required_schema_version:
        return False
    if record is not None:
        saved_record = result.get("record", {})
        if not isinstance(saved_record, dict) or any(
            saved_record.get(key) != record.get(key) for key in ("file_name", "text")
        ):
            return False
    checks = analysis.get("checks")
    if not isinstance(checks, dict) or analysis.get("call_category") not in CALL_CATEGORIES:
        return False
    if any(not isinstance(checks.get(key), dict) or checks[key].get("status") not in STATUS_VALUES for key in CHECK_KEYS):
        return False
    flags = analysis.get("red_flags")
    if not isinstance(flags, dict) or any(
        not isinstance(flags.get(key), dict) or flags[key].get("status") not in STATUS_VALUES
        for key in (RED_FLAG_KEYS if schema_version == ANALYSIS_SCHEMA_VERSION else RED_FLAG_KEYS[:-1])
    ):
        return False
    if schema_version == ANALYSIS_SCHEMA_VERSION and flags != normalize_red_flags(flags, checks):
        return False
    percent, _, earned, applicable, _ = score_checks(checks, analysis["call_category"])
    if any(analysis.get(key) != value for key, value in (
        ("quality_percent", percent), ("earned_points", earned), ("applicable_points", applicable)
    )):
        return False
    if analysis["call_category"] == "internal_operational":
        if any(check["status"] != "not_applicable" for check in checks.values()):
            return False
    return True


def normalize_status(value: Any, default: str = "unclear") -> str:
    status = str(value or default).strip().lower()
    return status if status in STATUS_VALUES else default


def normalize_check(value: Any) -> dict[str, str]:
    value = value if isinstance(value, dict) else {}
    return {
        "status": normalize_status(value.get("status")),
        "evidence": clean_text(value.get("evidence"), 300),
        "comment": clean_text(value.get("comment"), 360),
    }


def normalize_category(value: Any) -> str:
    value = clean_text(value, 100).lower()
    if value in CALL_CATEGORIES:
        return value
    aliases = {
        "спам": "spam_or_non_target",
        "нецел": "spam_or_non_target",
        "существ": "existing_order",
        "уточнен": "existing_order",
        "заказ": "new_order",
        "консульт": "consultation_without_clear_order",
        "внутрен": "internal_operational",
        "служеб": "internal_operational",
        "корот": "missed_call_or_too_short",
    }
    for marker, category in aliases.items():
        if marker in value:
            return category
    return "unclear"


def normalize_entity(value: Any) -> str:
    return re.sub(r"[^0-9a-zа-яё]+", " ", clean_text(value, 220).lower(), flags=re.I).strip()


def is_approved_legal_entity(value: Any) -> bool:
    normalized = normalize_entity(value)
    if not normalized:
        return False
    aliases = (
        "железная мебель юг",
        "железная мебель",
        "металлическая мебель",
        "айронэкс",
        "ооо мир",
        "борисов",
        "ядрышникова",
        "алешина",
    )
    return any(alias in normalized for alias in aliases)


def entity_is_supported_by_evidence(entity: Any, evidence: Any) -> bool:
    normalized_entity = normalize_entity(entity)
    normalized_evidence = normalize_entity(evidence)
    meaningful_tokens = [
        token for token in normalized_entity.split()
        if len(token) >= 4 and token not in {"общество", "индивидуальный", "предприниматель", "юридическое", "лицо"}
    ]
    return bool(meaningful_tokens) and any(token in normalized_evidence for token in meaningful_tokens)


def normalize_red_flags(value: Any, checks: dict[str, dict[str, str]]) -> dict[str, dict[str, str]]:
    value = value if isinstance(value, dict) else {}
    result: dict[str, dict[str, str]] = {}
    for key in RED_FLAG_KEYS:
        row = value.get(key) if isinstance(value.get(key), dict) else {}
        status = str(row.get("status") or "unclear").strip().lower()
        if status not in {"yes", "no", "unclear"}:
            status = "unclear"
        result[key] = {"status": status, "evidence": clean_text(row.get("evidence"), 300)}
        if key == "unauthorized_legal_entity_offer":
            result[key]["detected_entity"] = clean_text(row.get("detected_entity"), 220)

    website = checks.get("sent_to_website", {})
    if website.get("status") == "yes":
        result["redirected_to_website"] = {
            "status": "yes",
            "evidence": result["redirected_to_website"]["evidence"] or website.get("evidence", ""),
        }

    card_flag = result["third_party_card_transfer"]
    card_evidence = card_flag["evidence"].lower().replace("ё", "е")
    organization_card = re.search(
        r"карт(?:а|очка)\s+(?:предприятия|организации)|реквизит(?:ы|ов)?\s+(?:компании|организации)",
        card_evidence,
    )
    has_payment = re.search(r"перевест|оплат|деньг|рубл|сумм", card_evidence)
    has_bank_card = re.search(r"на\s+карт|номер\s+карт|личн\w*\s+карт|карт\w*\s+физ", card_evidence)
    if card_flag["status"] == "yes" and (organization_card or not (has_payment and has_bank_card)):
        card_flag["status"] = "no"
        card_flag["evidence"] = ""

    entity_flag = result["unauthorized_legal_entity_offer"]
    entity = entity_flag.get("detected_entity", "")
    entity_evidence = entity_flag["evidence"].lower().replace("ё", "е")
    sales_context = re.search(
        r"куп(?:ить|ите)|оформ(?:ить|им|ляем)|сч[её]т|договор|оплат|продад|реализуем|юр\w*\s+лиц",
        entity_evidence,
    )
    if entity_flag["status"] == "yes" and (
        not entity
        or is_approved_legal_entity(entity)
        or not sales_context
        or not entity_is_supported_by_evidence(entity, entity_evidence)
    ):
        entity_flag["status"] = "no"
        entity_flag["evidence"] = ""
        entity_flag["detected_entity"] = ""
    return result


def normalize_filler_words(value: Any) -> list[dict[str, Any]]:
    accepted_phrases = {
        "ну",
        "вот",
        "как бы",
        "типа",
        "короче",
        "в общем",
        "в принципе",
        "то есть",
        "так сказать",
        "собственно",
        "значит",
        "понимаете",
        "скажем так",
        "это самое",
        "как сказать",
        "на самом деле",
        "по сути",
        "ну вот",
        "ну как бы",
        "вот как бы",
    }
    result = []
    seen = set()
    for row in value if isinstance(value, list) else []:
        if not isinstance(row, dict):
            continue
        phrase = clean_text(row.get("phrase"), 60).lower().strip(" .,!?:;—-")
        canonical_phrase = re.sub(r"[^0-9a-zа-яё]+", " ", phrase, flags=re.I).strip()
        try:
            count = int(row.get("count") or 0)
        except (TypeError, ValueError):
            count = 0
        if not phrase or canonical_phrase not in accepted_phrases or count < 2 or phrase in seen:
            continue
        seen.add(phrase)
        result.append(
            {
                "phrase": phrase,
                "count": min(count, 30),
                "evidence": clean_text(row.get("evidence"), 240),
            }
        )
    return result[:8]


def score_checks(
    checks: dict[str, dict[str, str]], category: str
) -> tuple[float | None, float | None, float, float, dict[str, dict[str, Any]]]:
    details: dict[str, dict[str, Any]] = {}
    earned_points = 0.0
    applicable_points = 0.0
    for key, weight in QUALITY_WEIGHTS.items():
        status = checks.get(key, {}).get("status")
        factor = 1.0 if status == "yes" else 0.5 if status == "partial" else 0.0
        applicable = status in {"yes", "partial", "no"}
        earned = weight * factor if applicable else 0.0
        if applicable:
            applicable_points += weight
            earned_points += earned
        details[key] = {
            "weight": weight,
            "status": status,
            "earned_points": round(earned, 1),
            "applicable": applicable,
        }

    excluded = category in {
        "spam_or_non_target",
        "internal_operational",
        "missed_call_or_too_short",
    }
    if excluded or applicable_points < 35:
        return None, None, round(earned_points, 1), round(applicable_points, 1), details
    percent = round(100 * earned_points / applicable_points, 1)
    return percent, round(percent / 10, 1), round(earned_points, 1), round(applicable_points, 1), details


def normalize_analysis(
    data: Any,
    transcript: str = "",
    schema_version: str = ANALYSIS_SCHEMA_VERSION,
) -> dict[str, Any]:
    data = data if isinstance(data, dict) else {}
    checks_raw = data.get("checks") if isinstance(data.get("checks"), dict) else {}
    checks = {key: normalize_check(checks_raw.get(key)) for key in CHECK_KEYS}
    category = normalize_category(data.get("call_category"))

    # A full introduction requires both a personal name and a company marker in the cited evidence.
    # When the model only cites "Меня Андрей зовут", keep credit but cap it at "partial".
    introduction = checks["manager_introduced"]
    introduction_evidence = introduction.get("evidence", "").lower().replace("ё", "е")
    company_markers = (
        "железн",
        "компан",
        "организац",
        "магазин",
        "мебел",
        "сейф",
        "отдел продаж",
    )
    if introduction["status"] == "yes" and not any(marker in introduction_evidence for marker in company_markers):
        introduction["status"] = "partial"
        introduction["comment"] = clean_text(
            f"Полное представление не подтверждено: {introduction.get('comment', '')}",
            400,
        )

    if category == "new_order":
        checks["is_order"]["status"] = "yes"
        checks["is_spam_or_non_target"]["status"] = "no"
    elif category == "existing_order":
        checks["is_existing_order_clarification"]["status"] = "yes"
        checks["is_spam_or_non_target"]["status"] = "no"
    elif category == "spam_or_non_target":
        checks["is_spam_or_non_target"]["status"] = "yes"
        checks["is_order"]["status"] = "no"
    if category in {"spam_or_non_target", "internal_operational", "missed_call_or_too_short"}:
        for key in QUALITY_KEYS:
            checks[key]["status"] = "not_applicable"
    if category == "internal_operational":
        for key in CHECK_KEYS:
            checks[key]["status"] = "not_applicable"

    # For an intelligible target call, an omitted sales step is a failure, not an unknown.
    # Keep "unclear" only for genuinely short/noisy records and non-target conversations.
    source_quality = clean_text(data.get("source_quality"), 80) or "unclear"
    if category not in {"spam_or_non_target", "internal_operational", "missed_call_or_too_short"} and source_quality not in {"poor_transcript", "too_short", "unclear"}:
        for key in [
            "manager_introduced",
            "asked_client_name",
            "client_name_learned_or_used",
            "client_organization_identified",
            "needs_product_quantity_deadline",
            "needs_use_and_location",
            "offered_alternative",
            "offered_additional_products_services",
            "clarified_decision_timing",
            "clarified_procurement_method",
            "summarized_agreements",
            "scheduled_next_step",
            "correct_farewell",
            "sent_to_website",
            "is_existing_order_clarification",
        ]:
            if checks[key]["status"] == "unclear":
                checks[key]["status"] = "no"
        if checks["handled_objections"]["status"] == "unclear":
            checks["handled_objections"]["status"] = "not_applicable"
        if checks["is_spam_or_non_target"]["status"] == "unclear":
            checks["is_spam_or_non_target"]["status"] = "no"

    # The denominator must be deterministic for normal target calls. The model may
    # use not_applicable too liberally, so convert it to a visible failure for the
    # core steps that every sales conversation gives the manager a chance to do.
    target_categories = {"new_order", "existing_order", "consultation_without_clear_order"}
    if category in target_categories and source_quality not in {"poor_transcript", "too_short"}:
        always_applicable = [
            "manager_introduced",
            "asked_client_name",
            "client_name_learned_or_used",
            "needs_product_quantity_deadline",
            "needs_use_and_location",
            "summarized_agreements",
            "scheduled_next_step",
            "correct_farewell",
        ]
        if category in {"new_order", "existing_order"}:
            always_applicable.append("offered_additional_products_services")

        transcript_normalized = clean_text(transcript, 20000).lower().replace("ё", "е")
        b2b_markers = (
            "организац",
            "компан",
            "ооо",
            "ип ",
            "заказчик",
            "реквизит",
            "карта предпр",
            "карточка предпр",
            "карта организац",
            "карточка организац",
            "безнал",
            "по счету",
            "выставить счет",
            "коммерческ",
            "тендер",
            "аукцион",
            "площадк",
        )
        if any(marker in transcript_normalized for marker in b2b_markers):
            always_applicable.extend(
                ["client_organization_identified", "clarified_procurement_method"]
            )

        for key in always_applicable:
            if checks[key]["status"] == "not_applicable":
                checks[key]["status"] = "no"
                checks[key]["comment"] = clean_text(
                    f"Критерий применим к целевому звонку. {checks[key].get('comment', '')}",
                    400,
                )

        if checks["sent_to_website"]["status"] == "not_applicable":
            checks["sent_to_website"]["status"] = "no"

    red_flags = normalize_red_flags(data.get("red_flags"), checks)
    if schema_version == PRE_MOSCOW_SCHEMA_VERSION:
        red_flags.pop("unauthorized_legal_entity_offer", None)
    if category == "internal_operational":
        for flag in red_flags.values():
            flag["status"] = "no"
            flag["evidence"] = ""
            if "detected_entity" in flag:
                flag["detected_entity"] = ""
    elif category in target_categories and source_quality not in {"poor_transcript", "too_short"}:
        for flag in red_flags.values():
            if flag["status"] == "unclear" and not flag["evidence"]:
                flag["status"] = "no"
    quality_percent, quality_score_10, earned_points, applicable_points, score_details = score_checks(checks, category)
    confidence = data.get("confidence")
    try:
        confidence = max(0.0, min(1.0, float(confidence)))
    except (TypeError, ValueError):
        confidence = 0.0

    return {
        "schema_version": schema_version,
        "source_quality": source_quality,
        "call_category": category,
        "client_need": clean_text(data.get("client_need"), 700),
        "product_category": clean_text(data.get("product_category"), 120) or "неясно",
        "client_name": clean_text(data.get("client_name"), 120),
        "client_organization": clean_text(data.get("client_organization"), 220),
        "checks": checks,
        "red_flags": red_flags,
        "manager_filler_words": normalize_filler_words(data.get("manager_filler_words")),
        "missed_opportunities": [
            clean_text(item, 280)
            for item in (data.get("missed_opportunities") or [])
            if clean_text(item, 280)
        ][:3],
        "summary": clean_text(data.get("summary"), 700),
        "conclusion": clean_text(data.get("conclusion"), 700),
        "recommendation": clean_text(data.get("recommendation"), 700),
        "next_best_action": clean_text(data.get("next_best_action"), 500),
        "quality_percent": quality_percent,
        "quality_score_10": quality_score_10,
        "earned_points": earned_points,
        "applicable_points": applicable_points,
        "score_details": score_details,
        "confidence": round(confidence, 2),
    }


def extract_json(text: str) -> dict[str, Any]:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.I | re.S).strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I).strip()
    text = re.sub(r"\s*```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    if start < 0:
        raise ValueError("No JSON object found in model response")
    depth = 0
    in_string = False
    escape = False
    for index, char in enumerate(text[start:], start=start):
        if escape:
            escape = False
            continue
        if char == "\\":
            escape = True
        elif char == '"':
            in_string = not in_string
        elif not in_string and char == "{":
            depth += 1
        elif not in_string and char == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start : index + 1])
    raise ValueError("Unbalanced JSON object in model response")


def build_user_prompt(record: dict[str, Any]) -> str:
    meta = record.get("metadata_from_filename") or {}
    text = clean_text(record.get("text"), 8500) or "[пустой транскрипт]"
    return "\n".join(
        [
            "Проанализируй один звонок по системной инструкции.",
            "",
            "Метаданные:",
            f"- Файл: {record.get('file_name')}",
            f"- Дата и время: {meta.get('call_datetime')}",
            f"- Длительность, сек: {record.get('duration_sec')}",
            f"- Язык транскрипта: {record.get('language')}",
            "",
            "Транскрипт:",
            text,
        ]
    )


def call_ollama(
    model: str,
    prompt: str,
    url: str,
    num_ctx: int,
    timeout: int,
    system_prompt: str,
) -> tuple[str, dict[str, Any]]:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "format": "json",
        "think": False,
        "options": {"temperature": 0, "top_p": 0.9, "num_ctx": num_ctx, "num_predict": 4096},
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = json.loads(response.read().decode("utf-8"))
    return raw["message"]["content"], raw


def load_records(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def write_manifest(output_dir: Path, required_schema_version: str) -> None:
    rows = []
    for path in sorted((output_dir / "json").glob("*.json")):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
            if valid_cached_result(row, required_schema_version=required_schema_version):
                rows.append(row)
        except (OSError, json.JSONDecodeError):
            continue
    with (output_dir / "analysis_results.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze call transcripts with local Ollama.")
    parser.add_argument("--input", type=Path, default=Path("samara_transcripts/all_transcripts.jsonl"))
    parser.add_argument("--output-dir", type=Path, default=Path("samara_analysis_qwen25"))
    parser.add_argument("--model", default="qwen2.5:7b")
    parser.add_argument("--url", default="http://127.0.0.1:11434/api/chat")
    parser.add_argument("--num-ctx", type=int, default=8192)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument(
        "--analysis-schema-version",
        choices=sorted(SUPPORTED_SCHEMA_VERSIONS),
        default=ANALYSIS_SCHEMA_VERSION,
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    schema_version = args.analysis_schema_version
    system_prompt = system_prompt_for_schema(schema_version)
    records = load_records(args.input)
    if args.limit:
        records = records[: args.limit]
    output_dir = args.output_dir
    json_dir = output_dir / "json"
    json_dir.mkdir(parents=True, exist_ok=True)

    total = len(records)
    completed = 0
    for index, record in enumerate(records, start=1):
        output_path = json_dir / f"{Path(record['file_name']).stem}.json"
        if output_path.exists() and not args.overwrite:
            try:
                cached = json.loads(output_path.read_text(encoding="utf-8"))
            except (OSError, ValueError, json.JSONDecodeError):
                cached = None
            if valid_cached_result(cached, record, schema_version):
                completed += 1
                print(f"[{index}/{total}] skip {record['file_name']}", flush=True)
                continue

        error = None
        prompt = build_user_prompt(record)
        for attempt in range(1, args.retries + 2):
            try:
                started = time.time()
                content, raw = call_ollama(
                    args.model, prompt, args.url, args.num_ctx, args.timeout, system_prompt
                )
                analysis = normalize_analysis(
                    extract_json(content), record.get("text", ""), schema_version
                )
                if contains_cjk(analysis):
                    prompt = build_user_prompt(record) + "\nПовторная попытка: предыдущий ответ отклонён из-за китайского текста. Все текстовые поля, включая evidence и comment, должны быть только на русском языке."
                    raise ValueError("Модель вернула китайские иероглифы в анализе")
                result = {
                    "record": record,
                    "analysis": analysis,
                    "llm": {
                        "model": args.model,
                        "attempt": attempt,
                        "elapsed_sec": round(time.time() - started, 2),
                        "analyzed_at_utc": datetime.now(timezone.utc).isoformat(),
                        "eval_count": raw.get("eval_count"),
                    },
                }
                if not valid_cached_result(result, record, schema_version):
                    raise ValueError("Анализ не прошёл проверку структуры и расчётов")
                temporary_path = output_path.with_suffix(".json.tmp")
                temporary_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                temporary_path.replace(output_path)
                completed += 1
                print(
                    f"[{index}/{total}] done score={analysis['quality_percent']}% "
                    f"category={analysis['call_category']} elapsed={result['llm']['elapsed_sec']}s",
                    flush=True,
                )
                error = None
                break
            except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
                error = repr(exc)
                time.sleep(min(2 * attempt, 8))

        if error:
            with (output_dir / "errors.log").open("a", encoding="utf-8") as handle:
                handle.write(f"{datetime.now().isoformat()} {record['file_name']}: {error}\n")
            print(f"[{index}/{total}] ERROR {record['file_name']}: {error}", file=sys.stderr, flush=True)

    write_manifest(output_dir, schema_version)
    print(f"Completed {completed}/{total}. Output: {output_dir / 'analysis_results.jsonl'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
