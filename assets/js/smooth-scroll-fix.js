/**
 * Smooth scroll fix for anchor links
 * Prevents page reload when clicking anchor links on the same page
 */
(function() {
  'use strict';

  // Function to handle smooth scrolling
  function smoothScrollTo(targetId) {
    // Remove the # from the beginning if present
    var id = targetId.replace('#', '');

    // Try to find the target element by name attribute first (for <a name="...">)
    var target = document.querySelector('a[name="' + id + '"]');

    // If not found, try by ID
    if (!target) {
      target = document.getElementById(id);
    }

    // If still not found, try as a selector
    if (!target) {
      target = document.querySelector(targetId);
    }

    if (target) {
      // Scroll to the target
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });

      // Update URL without page reload
      if (history.pushState) {
        history.pushState(null, null, '#' + id);
      }

      return true;
    }

    return false;
  }

  // Wait for DOM to be ready
  function init() {
    // Get all links in the navigation
    var allLinks = document.querySelectorAll('a[href^="#"]');

    // Add click handler to each link
    allLinks.forEach(function(link) {
      link.addEventListener('click', function(e) {
        var href = this.getAttribute('href');

        // Only handle hash links
        if (href && href.startsWith('#') && href.length > 1) {
          e.preventDefault();
          smoothScrollTo(href);
        }
      });
    });
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // DOM is already ready
    init();
  }

})();

