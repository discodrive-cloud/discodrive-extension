import browser from 'webextension-polyfill'
import { localizePage } from '../lib/i18n.js'

localizePage()

document.getElementById('to-options').addEventListener('click', (e) => {
  e.preventDefault()
  browser.runtime.openOptionsPage()
})
