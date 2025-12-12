// =========================================================
// 1. LOGGER & UTILITIES
// =========================================================

const logOutput = document.getElementById('logOutput');
const reportContainer = document.getElementById('reportContainer'); // Target for the HTML Table
const reportOutput = document.getElementById('reportOutput'); // Pre-element for initial load/error

// Helper function for rounding and formatting numbers
const formatETB = (amount) => {
    if (typeof amount !== 'number' || isNaN(amount)) return '0.00';
    return amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

const log = (message, type = 'INFO') => {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${type}] ${message}\n`;
    
    console.log(`%c[${timestamp}][${type}] ${message}`, (type === 'SUCCESS' ? 'color: green; font-weight: bold;' : type === 'ERROR' ? 'color: red; font-weight: bold;' : 'color: grey;'));
    
    if (logOutput) {
        logOutput.textContent += logEntry;
        logOutput.scrollTop = logOutput.scrollHeight; 
    }
};

const clearLogs = () => {
    if (logOutput) {
        logOutput.textContent = '--- Start of New Session ---\n';
    }
    log('Logs cleared.', 'INFO');
};

// =========================================================
// 2. DATA CONFIGURATION (Fixed Business Rules)
// =========================================================

const EXPORT_DISCOUNT_FACTOR = 0.60; 
const OPTIMIZATION_DISCOUNT = 0.10; 

// Truck Type Profiles 
const TRUCK_PROFILES = {
    '40FT_DRY_VAN': { fuel_efficiency_km_l: 2.78, capacity_teu: 2, type: 'General Cargo' },
    '40FT_REEFER': { fuel_efficiency_km_l: 2.5, capacity_teu: 2, type: 'Refrigerated Cargo' },
    '15MT_FLATBED': { fuel_efficiency_km_l: 3.2, capacity_teu: 0, type: 'Non-Containerized' }
};

// =========================================================
// 3. CORE ENGINE LOGIC
// =========================================================

/**
 * Calculates the transport costs (Fuel + Driver Wage + Truck Rental).
 */
const calculateTransportCost = (distanceKm, truckType, estimatedDays, driverDailyWage, fuelPrice, truckRentalCost) => {
    const truck = TRUCK_PROFILES[truckType];
    const daysToCharge = Math.max(1, estimatedDays); 
    
    // Cost Components
    const totalLiters = distanceKm / truck.fuel_efficiency_km_l;
    const fuelCostETB = totalLiters * fuelPrice;
    const driverCostETB = daysToCharge * driverDailyWage;
    const truckRentETB = daysToCharge * truckRentalCost;

    const totalTransportCost = fuelCostETB + driverCostETB + truckRentETB;
    
    return {
        fuelCostETB,
        driverCostETB,
        truckRentETB, 
        totalTransportCost,
        totalLitersUsed: totalLiters
    };
};

/**
 * Calculates the Customs Duty based on CIF Value and the configurable rate.
 */
const calculateCustomsDuty = (cifValue, customsDutyRate, isExport) => {
    let dutyCost = 0;
    let dutyNotes = 'Customs Duty applies only to Import/Local cargo.';

    if (!isExport && customsDutyRate > 0) {
        const dutyFactor = customsDutyRate / 100;
        dutyCost = cifValue * dutyFactor;
        dutyNotes = `Calculated on CIF Value (${formatETB(cifValue)} ETB) at ${customsDutyRate}%.`;
    }
    
    return {
        dutyCost: dutyCost,
        dutyNotes: dutyNotes
    };
};


/**
 * Calculates the total tariff cost (Fees, Penalties, etc.).
 */
const calculateTariffCost = (estimatedDays, isExport, handlingCost, inspectionFee) => {
    
    let totalTariffCost = 0;
    const breakdown = [];
    const discountMultiplier = isExport ? (1 - EXPORT_DISCOUNT_FACTOR) : 1;
    
    const DYNAMIC_TARIFFS = [
        { name: "Dry Port Handling (40ft)", rate_birr: handlingCost, unit: 'per_container', is_export_eligible: true },
        { name: "Customs Inspection Fee (Fixed)", rate_birr: inspectionFee, unit: 'per_shipment', is_export_eligible: false },
        { name: "Storage Penalty (40ft, per day after 8 days)", rate_birr: 192.00, unit: 'per_day_after_free_period', free_days: 8, is_export_eligible: false }
    ];

    for (const tariff of DYNAMIC_TARIFFS) {
        
        let cost = 0;
        let notes = '';

        if (tariff.unit === 'per_container' || tariff.unit === 'per_shipment') {
            cost = tariff.rate_birr; 
            if (tariff.unit === 'per_container') notes = 'Base rate for 1 container.';
            else notes = 'Fixed mandatory fee.';
        }
        else if (tariff.unit === 'per_day_after_free_period') {
            const daysOverFreePeriod = Math.max(0, estimatedDays - tariff.free_days);
            if (daysOverFreePeriod > 0) {
                cost = daysOverFreePeriod * tariff.rate_birr;
                notes = `Penalty applied for ${daysOverFreePeriod} days over the ${tariff.free_days}-day free period.`;
            } else {
                notes = 'No penalty: Trip completed within the free period.';
            }
        }
        
        let finalCost = cost;
        if (isExport && tariff.is_export_eligible) {
            finalCost = cost * discountMultiplier;
            notes += ` EXPORT DISCOUNT Applied (${EXPORT_DISCOUNT_FACTOR * 100}% off eligible items).`;
        }
        
        if (finalCost > 0 || tariff.rate_birr > 0) {
            totalTariffCost += finalCost;
            breakdown.push({
                name: tariff.name.replace(/\s*\(.*\)/, ''), // Clean name for display
                cost: finalCost,
                notes: notes
            });
        }
    }
    
    return {
        totalTariffCost: totalTariffCost,
        breakdown: breakdown
    };
};

/**
 * Calculates the total tax cost based on the transport subtotal.
 */
const calculateTaxCost = (transportSubtotal, vatRate, whtRate) => {
    const vatFactor = vatRate / 100;
    const whtFactor = whtRate / 100;
    
    const vatCost = transportSubtotal * vatFactor;
    const whtCost = transportSubtotal * whtFactor;
    const totalTax = vatCost + whtCost;
    
    return { vatCost, whtCost, totalTax };
};


/**
 * Main function to calculate the total optimized cost (Single Run).
 */
const calculateTotalCost = (inputs) => {
    log('Starting Total Cost Calculation (Reading all rates from Display)...', 'INFO');
    
    const { distanceKm, estimatedDays, truckType, isExport, numStops, cifValue, customsDutyRate, driverCost, fuelPrice, truckRentalCost, vatRate, whtRate, handlingCost, inspectionFee } = inputs;

    // 1. Route Optimization Logic
    let actualDistanceKm = distanceKm;
    let optimizationNotes = 'No Route Optimization Applied.';
    
    if (numStops >= 3) {
        actualDistanceKm = distanceKm * (1 - OPTIMIZATION_DISCOUNT); 
        optimizationNotes = `Route Optimization Applied: Distance reduced by ${OPTIMIZATION_DISCOUNT * 100}% (from ${distanceKm} KM to ${actualDistanceKm.toFixed(2)} KM) for ${numStops} delivery stops.`;
        log(optimizationNotes, 'SUCCESS');
    }
    
    // 2. Calculate Transport and Tariff Costs
    const transportResults = calculateTransportCost(actualDistanceKm, truckType, estimatedDays, driverCost, fuelPrice, truckRentalCost); 
    const tariffResults = calculateTariffCost(estimatedDays, isExport, handlingCost, inspectionFee); 
    const dutyResults = calculateCustomsDuty(cifValue, customsDutyRate, isExport); 

    const transportSubtotal = transportResults.totalTransportCost;
    const dutyCost = dutyResults.dutyCost;
    const tariffSubtotal = tariffResults.totalTariffCost + dutyCost; 

    // 3. Calculate Tax Component
    const taxResults = calculateTaxCost(transportSubtotal, vatRate, whtRate);
    const totalTax = taxResults.totalTax;
    
    log(`Tax Calculation: VAT (${vatRate}%) + WHT (${whtRate}%) applied to Transport Subtotal.`, 'INFO');

    // 4. Combine All Components
    const totalOptimizedCost = transportSubtotal + tariffSubtotal + totalTax;

    log(`Total Cost Calculated: ${formatETB(totalOptimizedCost)} ETB`, 'SUCCESS');
    
    return {
        totalOptimizedCost: formatETB(totalOptimizedCost),
        transport: transportResults,
        tariffs: tariffResults,
        duty: dutyResults, 
        tax: taxResults,
        rates: inputs,
        optimization: {
            originalDistance: distanceKm,
            actualDistance: actualDistanceKm,
            notes: optimizationNotes,
            numStops: numStops
        },
        isExport: isExport
    };
};


// =========================================================
// 4. APPLICATION ENTRY POINT & REPORTING
// =========================================================

const generateReport = (results) => {
    
    const { transport, tariffs, duty, tax, rates, optimization } = results;
    
    const formatRow = (label, value, isSub = false) => {
        const subClass = isSub ? 'sub-item' : '';
        return `
            <tr>
                <td class="${subClass}">${label}</td>
                <td>${formatETB(value)}</td>
            </tr>
        `;
    };

    // Build Tariff/Duty breakdown rows
    let tariffBreakdownRows = [];
    
    // 1. Customs Duty
    if (duty.dutyCost > 0 || rates.customsDutyRate > 0) {
        tariffBreakdownRows.push(formatRow(`&nbsp;&nbsp;Gomruk Customs Duty (${rates.customsDutyRate}%)`, duty.dutyCost, true));
    }

    // 2. Other Tariffs (Handling, Inspection, Penalty)
    tariffs.breakdown.forEach(item => {
        if (item.cost > 0 || (item.name.includes("Penalty") && rates.estimatedDays > 8)) {
            tariffBreakdownRows.push(formatRow(`&nbsp;&nbsp;${item.name}`, item.cost, true));
        }
    });

    const finalSubtotalB = tariffs.totalTariffCost + duty.dutyCost;

    // Create the final HTML Table
    const reportHtml = `
        <table class="report-table">
            <thead>
                <tr>
                    <th colspan="2">TOTAL COST BREAKDOWN (Optimized Route)</th>
                </tr>
            </thead>
            <tbody>
                <tr style="background-color: #f8f9fa;">
                    <td colspan="2" style="font-style: italic; font-size: 0.9em; padding-bottom: 5px;">
                        Route: ${optimization.originalDistance} KM &rarr; ${formatETB(optimization.actualDistance)} KM | Days: ${rates.estimatedDays} | Cargo: ${results.isExport ? 'EXPORT' : 'IMPORT'}
                    </td>
                </tr>

                <tr>
                    <td class="section-header">A. TRANSPORT COST (Subtotal A)</td>
                    <td class="section-header">${formatETB(transport.totalTransportCost)}</td>
                </tr>
                ${formatRow('Fuel Cost (Optimized)', transport.fuelCostETB, true)}
                ${formatRow('Driver Wage (for 5 days)', transport.driverCostETB, true)}
                ${formatRow('Truck Rental (Fixed Cost)', transport.truckRentETB, true)}

                <tr>
                    <td class="section-header">B. TARIFFS & FEES</td>
                    <td class="section-header">${formatETB(finalSubtotalB)}</td>
                </tr>
                ${tariffBreakdownRows.join('')}

                <tr>
                    <td class="section-header">C. TAXES & COMPLIANCE (On Subtotal A)</td>
                    <td class="section-header">${formatETB(tax.totalTax)}</td>
                </tr>
                ${formatRow(`VAT (${rates.vatRate}%)`, tax.vatCost, true)}
                ${formatRow(`WHT (${rates.whtRate}%)`, tax.whtCost, true)}
            </tbody>
            <tfoot>
                <tr class="total-footer">
                    <th>TOTAL OPTIMIZED COST (ETB)</th>
                    <th>${results.totalOptimizedCost}</th>
                </tr>
            </tfoot>
        </table>
        
        <p style="margin-top: 15px; font-style: italic; font-size: 0.9em; color: #6c757d;">
            Optimization Note: ${optimization.notes}
        </p>
    `;

    reportContainer.innerHTML = reportHtml;
};


const handleCalculation = () => {
    clearLogs();
    
    // --- 1. Gather ALL Inputs ---
    const inputs = {
        distanceKm: parseFloat(document.getElementById('distance').value),
        estimatedDays: parseInt(document.getElementById('days').value),
        truckType: document.getElementById('truckType').value, 
        isExport: document.getElementById('isExport').value === 'true',
        numStops: parseInt(document.getElementById('numStops').value), 
        cifValue: parseFloat(document.getElementById('cifValue').value), 
        driverCost: parseFloat(document.getElementById('driverCost').value),
        truckRentalCost: parseFloat(document.getElementById('truckRentalCost').value),
        fuelPrice: parseFloat(document.getElementById('fuelPrice').value),
        vatRate: parseFloat(document.getElementById('vatRate').value),
        whtRate: parseFloat(document.getElementById('whtRate').value),
        inspectionFee: parseFloat(document.getElementById('inspectionFee').value),
        handlingCost: parseFloat(document.getElementById('handlingCost').value),
        customsDutyRate: parseFloat(document.getElementById('customsDutyRate').value)
    };

    // 2. Validation 
    if (Object.values(inputs).some(val => isNaN(val) && typeof val === 'number') || inputs.distanceKm <= 0 || inputs.estimatedDays <= 0 || inputs.numStops < 1) {
        log('Please enter valid, positive numbers for all fields.', 'ERROR');
        reportContainer.innerHTML = '<pre id="reportOutput" style="color: red;">INPUT ERROR: Check all numerical fields and Configuration Rates.</pre>';
        return;
    }

    try {
        // 3. Run the Core Engine (Single calculation run)
        const results = calculateTotalCost(inputs);
        
        // 4. Generate the Professional Table Report
        generateReport(results);
        
    } catch (e) {
        log(`Calculation Failed: ${e.message}`, 'CRITICAL ERROR');
        reportContainer.innerHTML = `<pre id="reportOutput" style="color: red;">CRITICAL ERROR: ${e.message}</pre>`;
    }
};

// Initialization
document.getElementById('calculateBtn').addEventListener('click', handleCalculation);
log('EthioRoute Engine Initialized, all rates are configurable.', 'SUCCESS');