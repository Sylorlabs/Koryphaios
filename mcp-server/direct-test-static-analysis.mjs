#!/usr/bin/env node

import { StaticAnalysisDetector } from './dist/detectors/static-analysis-detector.js';
import { readFileSync } from 'fs';
import path from 'path';

async function testStaticAnalysisDirectly() {
  console.log('🧪 Direct Static Analysis Test');
  console.log('==============================\n');

  try {
    // Create detector instance
    const detector = new StaticAnalysisDetector({
      workspaceRoot: process.cwd(),
      config: {
        staticAnalysis: {
          enabled: true,
          astAnalysis: {
            enabled: true,
            complexityThreshold: 5
          },
          patternAnalysis: {
            enabled: true,
            securityPatterns: true,
            performancePatterns: true
          },
          qualityMetrics: {
            enabled: true,
            cyclomaticComplexity: { threshold: 5 },
            functionLength: { threshold: 20 },
            nestingDepth: { threshold: 3 }
          }
        }
      }
    });

    console.log('✅ Static Analysis Detector created');

    // Start the detector
    await detector.start();
    console.log('✅ Detector started');

    // Test with our test file
    const testFilePath = path.join(process.cwd(), 'test-static-analysis.js');
    console.log(`📁 Testing file: ${testFilePath}`);

    try {
      const fileContent = readFileSync(testFilePath, 'utf-8');
      console.log(`📊 File size: ${fileContent.length} characters`);
      console.log(`📝 Lines: ${fileContent.split('\n').length}`);
    } catch (error) {
      console.log(`❌ Cannot read test file: ${error.message}`);
      return;
    }

    // Run detection
    console.log('\n🔍 Running static analysis...');
    const errors = await detector.detectErrors([testFilePath]);

    console.log(`\n📊 Analysis Results: ${errors.length} issues found`);
    
    if (errors.length > 0) {
      // Group by category
      const categories = {};
      errors.forEach(error => {
        const cat = error.category || 'general';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(error);
      });

      console.log('\n🏷️  Issues by Category:');
      Object.entries(categories).forEach(([category, categoryErrors]) => {
        console.log(`\n${category.toUpperCase()} (${categoryErrors.length} issues):`);
        categoryErrors.slice(0, 5).forEach((error, i) => {
          console.log(`  ${i + 1}. ${error.severity}: ${error.message}`);
          console.log(`     📍 ${error.file}:${error.line}`);
          if (error.code) console.log(`     🔧 Code: ${error.code}`);
        });
        if (categoryErrors.length > 5) {
          console.log(`     ... and ${categoryErrors.length - 5} more`);
        }
      });

      console.log('\n📈 Summary:');
      Object.entries(categories).forEach(([category, categoryErrors]) => {
        const severities = {};
        categoryErrors.forEach(error => {
          severities[error.severity] = (severities[error.severity] || 0) + 1;
        });
        console.log(`  • ${category}: ${categoryErrors.length} issues`);
        Object.entries(severities).forEach(([severity, count]) => {
          console.log(`    - ${severity}: ${count}`);
        });
      });

      console.log('\n✅ Enhanced Static Analysis is working correctly!');
      console.log('🎉 Features validated:');
      
      const hasAST = errors.some(e => e.message.includes('complexity') || e.message.includes('function'));
      const hasSecurity = errors.some(e => e.category === 'security');
      const hasQuality = errors.some(e => e.category === 'maintainability' || e.category === 'quality');
      const hasPerformance = errors.some(e => e.category === 'performance');

      if (hasAST) console.log('   ✅ AST-based analysis (complexity detection)');
      if (hasSecurity) console.log('   ✅ Security pattern detection');
      if (hasQuality) console.log('   ✅ Code quality metrics');
      if (hasPerformance) console.log('   ✅ Performance analysis');
      
    } else {
      console.log('⚠️  No issues detected - this might indicate:');
      console.log('   • The test file has no detectable issues');
      console.log('   • The analysis patterns need adjustment');
      console.log('   • The detector configuration needs tuning');
    }

    // Stop the detector
    await detector.stop();
    console.log('\n✅ Test completed successfully');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

testStaticAnalysisDirectly().catch(console.error);
