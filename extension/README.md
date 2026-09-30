# Gulpy for Chrome

Connects all the apps you already use to Gulpy with one click.

1. Open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked**, and choose this folder.
2. Open https://app.gulpy.ai/connect-all and select **Connect everything**.

The extension opens each app in a background tab, where you are already signed in, and taps
**Allow** for Gulpy. Apps where you are not signed in are skipped. Google and Microsoft keep one
tap by you. Remove any tool later on My tools.

Safety rules (see `background.js`): only the Gulpy page `/connect-all` can start it, only with
Gulpy `/connect/...` addresses; the clicker runs only in tabs the extension opened, and only on
pages that name Gulpy.
