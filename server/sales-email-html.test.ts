import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesEmailHtml, wrapSalesEmail } from './sales-email-html';

describe('sales-email-html marketing shell', () => {
  it('escapes HTML in body and subject', () => {
    const html = buildSalesEmailHtml({
      subject: 'Hi <script>alert(1)</script>',
      bodyText: 'Hello <b>Shervin</b> & friends',
      showPackages: false,
    });
    assert.match(html, /Hi &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /Hello &lt;b&gt;Shervin&lt;\/b&gt; &amp; friends/);
    assert.doesNotMatch(html, /<script>alert/);
  });

  it('includes website CTA and package cards by default', () => {
    const { text, html } = wrapSalesEmail('Thanks for the chat today.\n\nCheers,\nSally');
    assert.equal(text.includes('Thanks for the chat today.'), true);
    assert.match(html, /https:\/\/sync2dine\.io/);
    assert.match(html, /See Sync2Dine/);
    assert.match(html, /Launch packages/);
    assert.match(html, /Atmosphere/);
    assert.match(html, /Judie Starter/);
    assert.equal(html.includes('208'), true);
    assert.match(html, /sync2dine-phone-agent\.jpg/);
  });

  it('can omit packages and use a custom CTA', () => {
    const html = buildSalesEmailHtml({
      bodyText: 'Short note',
      showPackages: false,
      ctaUrl: 'https://sync2dine.io/pricing',
      ctaLabel: 'View pricing',
    });
    assert.doesNotMatch(html, /Launch packages/);
    assert.match(html, /https:\/\/sync2dine\.io\/pricing/);
    assert.match(html, /View pricing/);
  });

  it('keeps plain-text fallback separate from HTML', () => {
    const body = 'Hi Shervin,\n\nSee you tomorrow at 10am.\n\nCheers,\nSally';
    const wrapped = wrapSalesEmail(body, { subject: 'Next steps' });
    assert.equal(wrapped.text, body);
    assert.match(wrapped.html, /See you tomorrow at 10am/);
    assert.match(wrapped.html, /<!DOCTYPE html>/);
  });
});
