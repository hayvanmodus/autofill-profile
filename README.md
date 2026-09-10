# AutoFill Profile

A browser extension that fills job application forms from a profile you set up once.

## The problem

Job applications ask the same fields every time. Name, email, phone, address, education, work history, languages, skills, and the standard yes/no questions like work authorization and visa sponsorship. Browser autofill only knows name, address, and phone. It has no idea what to do with the rest, so you end up retyping the same information on every application.

## Features

- Fill your profile once in the options page, or import it from a PDF CV.
- Field matching works in eight languages: English, Italian, German, Turkish, Spanish, French, Portuguese, and Dutch.
- Works on ATS platforms, including Greenhouse and Workday.
- Handles standard application questions like work authorization and visa sponsorship.
- Leaves a field blank rather than guessing wrong.
- Optional AI fallback for fields it can't match locally.

## Privacy

Your profile is stored locally in `chrome.storage.local`. There are no servers and no analytics. Fonts are bundled locally, so the interface itself makes no network requests. Nothing is sent anywhere unless you add your own Anthropic API key for the optional AI fallback.

## Installation

This extension is not on the Chrome Web Store. Install it as an unpacked extension:

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on Developer mode (top right).
4. Click "Load unpacked" and select the repository folder.
5. Open the extension's options page and fill in your profile.

## Status

This is early. Feedback is welcome.
