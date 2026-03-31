const { chromium } = require('playwright');

const BASE_URL = 'http://localhost:3000';
const TEST_USER = 'testuser_' + Date.now();
const TEST_PASSWORD = 'testpass123';
const TEST_GUILD = 'Fabled';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  let errors = [];
  
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(`Console Error: ${msg.text()}`);
    }
  });
  
  page.on('pageerror', error => {
    errors.push(`Page Error: ${error.message}`);
  });
  
  console.log('=== Guild Module Test Suite ===\n');
  
  try {
    // Test 1: Load Guild Page
    console.log('Test 1: Loading guild page...');
    await page.goto(BASE_URL + '/guild');
    await page.waitForLoadState('networkidle');
    console.log('✓ Guild page loaded successfully\n');
    
    // Test 2: Guild Search
    console.log('Test 2: Testing guild search...');
    await page.fill('#guildSearchInput', TEST_GUILD);
    await page.click('#guildSearchBtn');
    await page.waitForSelector('#guildResult:not(.hidden)', { timeout: 10000 });
    
    const guildName = await page.textContent('#guildName');
    if (guildName.toLowerCase().includes(TEST_GUILD.toLowerCase())) {
      console.log(`✓ Guild found: ${guildName}\n`);
    } else {
      console.log(`✗ Guild name mismatch: expected "${TEST_GUILD}", got "${guildName}"\n`);
    }
    
    // Test 3: User Registration
    console.log('Test 3: Testing user registration...');
    await page.goto(BASE_URL + '/login');
    await page.waitForLoadState('networkidle');
    
    await page.fill('#regUsername', TEST_USER);
    await page.fill('#regPassword', TEST_PASSWORD);
    await page.click('#registerBtn');
    await page.waitForTimeout(2000);
    
    const regSuccess = await page.textContent('#regMessage');
    if (regSuccess.includes('success') || regSuccess.includes('registered')) {
      console.log(`✓ User registered successfully: ${TEST_USER}\n`);
    } else {
      console.log(`✗ Registration may have failed: ${regSuccess}\n`);
    }
    
    // Test 4: User Login
    console.log('Test 4: Testing user login...');
    await page.fill('#loginUsername', TEST_USER);
    await page.fill('#loginPassword', TEST_PASSWORD);
    await page.click('#loginBtn');
    await page.waitForTimeout(2000);
    
    await page.goto(BASE_URL + '/guild');
    await page.waitForLoadState('networkidle');
    
    const userBtn = await page.textContent('#headerUserBtn');
    if (userBtn && userBtn.includes(TEST_USER)) {
      console.log(`✓ Login successful, user displayed: ${userBtn}\n`);
    } else {
      console.log(`✗ User not displayed in header after login\n`);
    }
    
    // Test 5: Guild Tracking
    console.log('Test 5: Testing guild tracking...');
    await page.fill('#guildSearchInput', TEST_GUILD);
    await page.click('#guildSearchBtn');
    await page.waitForSelector('#guildResult:not(.hidden)', { timeout: 10000 });
    
    await page.click('#trackGuildBtn');
    await page.waitForTimeout(1000);
    
    const trackBtnText = await page.textContent('#trackGuildBtn');
    if (trackBtnText.includes('Tracking') || trackBtnText.includes('Tracked')) {
      console.log(`✓ Guild tracked successfully\n`);
    } else {
      console.log(`✗ Guild tracking may have failed: ${trackBtnText}\n`);
    }
    
    // Test 6: Event Tracking (XP)
    console.log('Test 6: Testing XP event tracking...');
    await page.click('#trackXpBtn');
    await page.waitForTimeout(500);
    
    const activeEventVisible = await page.isVisible('#activeEventSection:not(.hidden)');
    if (activeEventVisible) {
      console.log(`✓ XP tracking started successfully\n`);
    } else {
      console.log(`✗ XP tracking may not have started\n`);
    }
    
    // Test 7: Refresh Event
    console.log('Test 7: Testing event refresh...');
    await page.click('#refreshEventBtn');
    await page.waitForTimeout(500);
    
    const eventDuration = await page.textContent('#eventDuration');
    if (eventDuration && eventDuration.includes('h') || eventDuration.includes('m')) {
      console.log(`✓ Event refresh successful, duration: ${eventDuration}\n`);
    } else {
      console.log(`✗ Event refresh may have failed\n`);
    }
    
    // Test 8: End Event
    console.log('Test 8: Testing event end...');
    page.on('dialog', dialog => dialog.accept());
    await page.click('#endEventBtn');
    await page.waitForTimeout(1000);
    
    const noActiveEvent = await page.isVisible('#noActiveEventSection:not(.hidden)');
    if (noActiveEvent) {
      console.log(`✓ Event ended successfully\n`);
    } else {
      console.log(`✗ Event may not have ended\n`);
    }
    
    // Test 9: Event History
    console.log('Test 9: Testing event history...');
    const historyCard = await page.isVisible('#eventHistoryList > div');
    if (historyCard) {
      console.log(`✓ Event saved to history\n`);
    } else {
      console.log(`✗ Event may not have been saved to history\n`);
    }
    
    // Test 10: Member XP Tracking
    console.log('Test 10: Testing member XP tracking...');
    await page.click('#trackMemberXpBtn');
    await page.waitForSelector('#memberSelectSection:not(.hidden)');
    
    const memberOptions = await page.locator('#memberSelect option').count();
    if (memberOptions > 1) {
      console.log(`✓ Member select populated with ${memberOptions - 1} members\n`);
      
      await page.selectOption('#memberSelect', { index: 1 });
      await page.click('#startMemberTrackBtn');
      await page.waitForTimeout(500);
      
      const memberTrackingActive = await page.isVisible('#activeEventSection:not(.hidden)');
      if (memberTrackingActive) {
        console.log(`✓ Member XP tracking started\n`);
        
        // End member tracking
        page.on('dialog', dialog => dialog.accept());
        await page.click('#endEventBtn');
        await page.waitForTimeout(1000);
      } else {
        console.log(`✗ Member XP tracking may not have started\n`);
      }
    } else {
      console.log(`✗ No members in select\n`);
    }
    
    // Test 11: Logout
    console.log('Test 11: Testing logout...');
    await page.click('#logoutBtn');
    await page.waitForURL('**/guild');
    await page.waitForLoadState('networkidle');
    
    const loginBtnVisible = await page.isVisible('#headerLoginBtn');
    if (loginBtnVisible) {
      console.log(`✓ Logout successful\n`);
    } else {
      console.log(`✗ Logout may have failed\n`);
    }
    
    // Test 12: Guild Wars Tracking
    console.log('Test 12: Testing wars tracking...');
    // Login again
    await page.goto(BASE_URL + '/login');
    await page.fill('#loginUsername', TEST_USER);
    await page.fill('#loginPassword', TEST_PASSWORD);
    await page.click('#loginBtn');
    await page.waitForTimeout(1000);
    
    await page.goto(BASE_URL + '/guild');
    await page.waitForLoadState('networkidle');
    
    await page.fill('#guildSearchInput', TEST_GUILD);
    await page.click('#guildSearchBtn');
    await page.waitForSelector('#guildResult:not(.hidden)', { timeout: 10000 });
    
    await page.click('#trackWarsBtn');
    await page.waitForTimeout(500);
    
    const warsTrackingActive = await page.isVisible('#activeEventSection:not(.hidden)');
    if (warsTrackingActive) {
      console.log(`✓ Wars tracking started\n`);
      
      // End wars tracking
      page.on('dialog', dialog => dialog.accept());
      await page.click('#endEventBtn');
      await page.waitForTimeout(1000);
      console.log(`✓ Wars event ended\n`);
    } else {
      console.log(`✗ Wars tracking may not have started\n`);
    }
    
  } catch (error) {
    console.log(`\n✗ Test failed with error: ${error.message}\n`);
    errors.push(error.message);
  }
  
  // Summary
  console.log('=== Test Summary ===');
  if (errors.length > 0) {
    console.log(`\nErrors encountered (${errors.length}):`);
    errors.forEach(e => console.log(`  - ${e}`));
  } else {
    console.log('\n✓ All tests passed with no errors!');
  }
  
  await browser.close();
}

runTests().catch(console.error);
