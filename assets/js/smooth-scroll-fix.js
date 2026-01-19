/**
 * Smooth scroll fix for anchor links
 * Prevents page reload when clicking anchor links on the same page
 */
(function() {
  'use strict';

  // Wait for DOM to be ready
  document.addEventListener('DOMContentLoaded', function() {
    
    // Get all navigation links
    var navLinks = document.querySelectorAll('.masthead__menu a[href*="#"]');
    
    navLinks.forEach(function(link) {
      link.addEventListener('click', function(e) {
        var href = this.getAttribute('href');
        
        // Check if it's a hash-only link or same-page link
        if (href.startsWith('#')) {
          // Pure anchor link like #about-me
          e.preventDefault();
          scrollToTarget(href);
        } else if (href.includes('#')) {
          // Link like /page#section
          var parts = href.split('#');
          var path = parts[0];
          var hash = '#' + parts[1];
          
          // Check if we're on the same page
          if (isSamePage(path)) {
            e.preventDefault();
            scrollToTarget(hash);
          }
        }
      });
    });
    
    // Also handle the hardcoded Homepage link
    var homeLinks = document.querySelectorAll('.masthead__menu-home-item a');
    homeLinks.forEach(function(link) {
      link.addEventListener('click', function(e) {
        var href = this.getAttribute('href');
        if (href.startsWith('#')) {
          e.preventDefault();
          scrollToTarget(href);
        }
      });
    });
    
  });
  
  /**
   * Scroll to target element smoothly
   */
  function scrollToTarget(hash) {
    var target = document.querySelector(hash);
    if (target) {
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
      
      // Update URL without triggering page reload
      if (history.pushState) {
        history.pushState(null, null, hash);
      } else {
        window.location.hash = hash;
      }
    }
  }
  
  /**
   * Check if the given path is the same as current page
   */
  function isSamePage(path) {
    var currentPath = window.location.pathname;
    
    // Normalize paths
    if (path === '/' || path === '') {
      path = '/';
    }
    if (currentPath === '' || currentPath === '/index.html') {
      currentPath = '/';
    }
    
    return path === currentPath;
  }
  
})();

