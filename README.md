# Crypto → RUB for Google Sheets

Apps Script, который пишет цены монет в **₽** в вашу таблицу Google. Источник цены в USD: **Coinbase → Kraken → Bitfinex (fallback)**. Конвертация в рубли по курсу **USD/RUB ЦБ РФ**.

## Установка
1. Создайте проект **Apps Script** (можно standalone).
2. Вставьте код из `CryptoUpdate.gs`.
3. Вверху файла задайте `SPREADSHEET_ID = "<ID вашей таблицы>"`.
4. Запустите функцию `CRYPTO_UPDATE_RUB` один раз (создаст лист `Crypto`).
5. В `Crypto!A2:A` впишите монеты (например: `btc`, `eth`, `sol`, `usdt`).
6. Поставьте триггер: **CRYPTO_UPDATE_RUB**, каждые **5–15 минут**.

## Формат листа `Crypto`
`id_or_alias | resolved_base | source | price_rub | updated_at | status`

## Примечания
- Ключи API не нужны.
- Стейблы (USDT/USDC) = курс USD/RUB ЦБ.
- Уважайте лимиты публичных API; не ставьте частые триггеры.
