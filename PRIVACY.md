# Privacy Policy

AutoFill Profile does not collect, transmit, or share any user data.

## What the extension stores

The profile you enter in the options page is saved locally on your device using chrome.storage.local. This includes your name, contact details, address, links, education, work history, languages, skills, and any long-form answers you write.

This data never leaves your device. There are no servers, no analytics, and no tracking.

## Optional AI fallback

The extension includes an optional feature that uses the Anthropic API to match form fields it cannot identify locally. This feature is off by default and only works if you add your own API key.

If you enable it, field labels from the page are sent to the Anthropic API. Your profile data is not sent. If you also enable CV import with an API key set, the text of the CV you upload is sent to the Anthropic API for parsing. The extension tells you this before you upload.

Without an API key, no network requests are made at all.

## Permissions

The extension requests the storage permission to save your profile, and host permissions to run on any page, because job application forms are hosted across many different domains.

## Contact

Questions or issues: https://github.com/hayvanmodus/autofill-profile/issues