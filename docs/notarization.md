# Подпись и нотарификация релиза для macOS

Для распространения ZIP вне Mac App Store требуется сертификат **Developer ID Application** с закрытым ключом в связке ключей Mac и доступ к Apple Notary Service. Сертификат выпускает владелец аккаунта Apple Developer Program. Бесплатная Personal Team поддерживает локальную разработку. [Сертификаты Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)

## Проверка опубликованной сборки

Команды рассчитаны на Apple Silicon и версию из `package.json`. Для 0.6.1 исходным артефактом служит ZIP из опубликованного релиза. В чистом каталоге проекта выполните:

```sh
npm ci
mkdir -p dist/signing-input
gh release download v0.6.1 -R rly-ecosystem/ade \
  --pattern RLY-ADE-0.6.1-macOS-arm64.zip --dir dist/signing-input
archive=dist/signing-input/RLY-ADE-0.6.1-macOS-arm64.zip
sha=0fbc307b64d5f3243fd80caa968c50a19bc51fbeee506a12551ec164c562c352
npm run notarize -- "$archive" "$sha" --check
```

`--check` сверяет контрольную сумму, версию и идентификатор приложения. Затем он подписывает отдельную копию с Hardened Runtime и проверяет вложенные подписи после повторной упаковки и распаковки. Для этой проверки используется временная ad-hoc подпись. При запуске такого экземпляра macOS может отклонить загрузку Electron Framework из-за отсутствия Team ID. Для распространения и проверки запуска предназначен следующий этап.

## Отправка в Apple

Подключите команду Apple Developer Program в Xcode. В **Settings → Accounts → Manage Certificates** добавьте **Developer ID Application** или установите уже выпущенный сертификат вместе с доступом к его закрытому ключу. Для сохранения учётных данных нотарификации используйте локальный интерактивный запрос:

```sh
xcrun notarytool store-credentials RLY-ADE
npm run notarize -- "$archive" "$sha"
```

При нескольких Developer ID Application задайте `ADE_SIGN_IDENTITY` равным SHA-1 нужной записи из `security find-identity -v -p codesigning`. Имя существующего профиля нотарификации можно передать через `ADE_NOTARY_PROFILE`.

Команда подписывает вложенный код и приложение с временной меткой Apple. После статуса `Accepted` она прикрепляет билет к приложению и заново создаёт ZIP. На распакованной копии выполняются проверка Developer ID, `stapler validate`, `syspolicy_check distribution`, проверка Gatekeeper и GUI-тест запуска. Нужна графическая сессия macOS. При успехе команда выводит путь к каталогу `dist/notarized-<submission-id>/` с архивом и новым `SHA256SUMS.txt`. ID отправки выводится до ожидания результата, чтобы можно было проверить состояние через `xcrun notarytool info <id> --keychain-profile RLY-ADE`.

Для обновления существующего релиза загрузите проверенные ZIP и `SHA256SUMS.txt` в GitHub Releases. Сверьте SHA-256 скачанного через публичную ссылку ZIP и выполните `xcrun stapler validate` и `spctl --assess --type execute --verbose=4` на распакованном приложении. Затем обновите описание подписи в релизе и README. macOS может запросить обычное подтверждение при первом открытии приложения из интернета. [Gatekeeper и первый запуск](https://support.apple.com/en-us/102445)
